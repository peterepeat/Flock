"use client";

import { useEffect, useState } from "react";

import { getRecentFlocks, removeRecentFlock, type RecentFlock } from "@/lib/recentStore";

// Landing-page "jump back in" list — shown ONLY when this browser has flock history. An alternative
// entry point next to "Start your flock party". Each row links to the flock with a subtle ✕ to forget it.
export default function RecentFlocks() {
  const [flocks, setFlocks] = useState<RecentFlock[]>([]);
  // Client-only (localStorage) — render nothing during SSR / first paint, then the list if any.
  useEffect(() => {
    setFlocks(getRecentFlocks());
  }, []);

  if (flocks.length === 0) return null;

  function remove(id: string) {
    removeRecentFlock(id);
    setFlocks(getRecentFlocks());
  }

  return (
    <div className="mt-10 w-full max-w-xs text-left">
      <div className="mb-2 text-center text-[11px] uppercase tracking-wider text-fog/70">Or jump back into</div>
      <ul className="overflow-hidden rounded-xl border border-white/10 bg-surface-mid/70 backdrop-blur">
        {flocks.map((f) => (
          <li key={f.id} className="group flex items-stretch border-b border-white/5 last:border-0">
            <a href={`/flock/${f.id}`} className="flex min-w-0 flex-1 flex-col px-4 py-2.5 transition hover:bg-surface-lift">
              <span className="truncate text-sm text-text">{f.name || `flock/${f.id}`}</span>
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
    </div>
  );
}
