"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { createFlock } from "@/lib/flockApi";
import { createLogger } from "@/lib/logger";
import { getRecentFlocks, removeRecentFlock, type RecentFlock } from "@/lib/recentStore";

const log = createLogger("flock-switcher");

// The header title cluster ("Flock Party · <name> ▾") is a dropdown: jump to any recent flock, start a
// new one, or drop one from the list. Per-browser localStorage only — no server, no engine. The whole
// cluster is the trigger so it works on mobile too (where the name is hidden, it's just "Flock Party ▾").
export default function FlockSwitcher({ flockId, flockName }: { flockId: string; flockName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [flocks, setFlocks] = useState<RecentFlock[]>([]);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Read fresh each time it opens (the current flock's name may have just changed).
  useEffect(() => {
    if (open) setFlocks(getRecentFlocks());
  }, [open]);

  // Dismiss on outside-click + Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function remove(id: string) {
    removeRecentFlock(id);
    setFlocks(getRecentFlocks());
  }

  async function newFlock() {
    if (creating) return;
    setCreating(true);
    try {
      router.push(`/flock/${await createFlock()}`);
    } catch (err) {
      log.error("could not start a new flock", { error: String(err) });
      setCreating(false);
    }
  }

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch flock"
        className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-surface-lift sm:gap-3"
      >
        <span className="whitespace-nowrap text-base font-semibold tracking-tight">Flock Party</span>
        {flockName && <span className="hidden min-w-0 truncate text-sm text-fog sm:inline">{flockName}</span>}
        <Chevron open={open} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-[1100] mt-1 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-white/10 bg-surface-mid shadow-panel"
        >
          <div className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wider text-fog/70">Recent flocks</div>
          <ul className="max-h-72 overflow-auto flock-scroll">
            {flocks.length === 0 && <li className="px-3 py-2 text-xs text-fog">No recent flocks yet.</li>}
            {flocks.map((f) => (
              <li key={f.id} className="group flex items-stretch">
                <a
                  href={`/flock/${f.id}`}
                  role="menuitem"
                  className={`flex min-w-0 flex-1 flex-col px-3 py-2 transition hover:bg-surface-lift ${f.id === flockId ? "bg-surface-lift/50" : ""}`}
                >
                  <span className="flex items-center gap-1.5 truncate text-sm text-text">
                    {f.id === flockId && <span className="shrink-0 text-together" aria-label="current flock">●</span>}
                    <span className="truncate">{f.name || `flock/${f.id}`}</span>
                  </span>
                  <span className="mono truncate text-[11px] text-fog">flock/{f.id}</span>
                </a>
                <button
                  type="button"
                  onClick={() => remove(f.id)}
                  aria-label={`Remove ${f.name || f.id} from recent flocks`}
                  className="shrink-0 px-3 text-sm text-fog/50 transition hover:text-accent"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={newFlock}
            disabled={creating}
            role="menuitem"
            className="block w-full border-t border-white/5 px-3 py-2.5 text-left text-sm text-accent transition hover:bg-surface-lift disabled:opacity-60"
          >
            {creating ? "Starting…" : "+ Start a new flock"}
          </button>
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 text-fog transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
