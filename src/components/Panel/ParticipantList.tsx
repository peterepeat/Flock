"use client";

import { useEffect, useRef, useState } from "react";

import ScheduleView from "@/components/Panel/ScheduleView";
import LockToggle from "@/components/ui/LockToggle";
import { initial } from "@/lib/colors";
import { setRunnerLock } from "@/lib/flockApi";
import { formatDistance } from "@/lib/units";
import { useFlockStore, useUnit } from "@/store/flockStore";

export default function ParticipantList() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const apply = useFlockStore((s) => s.applyServerSession);
  const openEditForm = useFlockStore((s) => s.openEditForm);
  const setHovered = useFlockStore((s) => s.setHovered);
  const setSelected = useFlockStore((s) => s.setSelected);
  const expandedId = useFlockStore((s) => s.expandedParticipantId);
  const setExpanded = useFlockStore((s) => s.setExpanded);
  const calcWarnings = useFlockStore((s) => s.calcWarnings);
  const unit = useUnit();
  // No ownership anymore — anyone may edit a runner unless the runners section or that
  // runner is locked. Editing a runner reverts to the form (which holds "Leave the flock").
  const runnersLocked = session?.locks?.runners ?? false;
  const runnerLocks = session?.runnerLocks ?? {};

  const toggleRunnerLock = (pid: string, current: boolean) => {
    void setRunnerLock(flockId, pid, !current)
      .then((s) => apply(s, true))
      .catch(() => {});
  };

  if (!session || session.participants.length === 0) {
    return (
      <p className="px-1 py-4 text-sm text-text-dim">
        No one’s here yet. Be the first to join.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {session.participants.map((p) => {
        const route = session.computedRoutes?.find((r) => r.participantId === p.id);
        const runnerLocked = !!runnerLocks[p.id];
        const editable = !runnersLocked && !runnerLocked;
        const isExpanded = expandedId === p.id;
        const warnings = calcWarnings.filter((w) => w.participantId === p.id).map((w) => w.message);
        return (
          <li key={p.id}>
            <div
              onMouseEnter={() => setHovered(p.id)}
              onMouseLeave={() => setHovered(null)}
              className="rounded-lg transition hover:bg-surface-lift"
            >
              <div className="flex items-center gap-3 px-2 py-2">
                <button
                  type="button"
                  onClick={() => {
                    const willExpand = !isExpanded;
                    setExpanded(willExpand ? p.id : null);
                    // Expanding a runner also focuses their route on the map.
                    setSelected(willExpand ? p.id : null);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  aria-expanded={isExpanded}
                >
                  <span
                    className="mono flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs text-[#15151a]"
                    style={{ background: p.color }}
                  >
                    {initial(p.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="truncate text-sm text-text">{p.name}</span>
                    {route && (
                      <span className="mono block text-xs text-fog">
                        {formatDistance(route.distanceKm, unit)} ·{" "}
                        {route.departureTime}–{route.arrivalTime}
                      </span>
                    )}
                  </span>
                </button>
                {warnings.length > 0 && <WarningBadge messages={warnings} />}
                {editable && (
                  <button
                    type="button"
                    onClick={() => openEditForm(p.id)}
                    className="shrink-0 text-xs text-fog hover:text-text"
                  >
                    edit
                  </button>
                )}
                {/* A locked row can't be edited, so surface its GPX right here (no need
                    to expand the schedule). In edit mode the download lives in the drawer. */}
                {!editable && route && (
                  <a
                    href={`/api/gpx/${flockId}/${p.id}`}
                    download
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-dim transition hover:bg-surface-lift hover:text-together"
                    aria-label={`Download ${p.name}'s route as GPX`}
                    title="Download GPX route"
                  >
                    <DownloadIcon />
                    <span>GPX</span>
                  </a>
                )}
                <LockToggle
                  locked={runnerLocked}
                  onToggle={() => toggleRunnerLock(p.id, runnerLocked)}
                  label={runnerLocked ? `Unlock ${p.name}` : `Lock ${p.name}`}
                />
              </div>
              {isExpanded && (
                <div className="px-2 pb-2">
                  <ScheduleView participantId={p.id} />
                  {route && (
                    <a
                      href={`/api/gpx/${flockId}/${p.id}`}
                      className="mt-2 block rounded-full bg-together px-4 py-2 text-center text-sm font-medium text-[#0c1413] hover:brightness-110"
                    >
                      Download your route
                    </a>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Per-person notes (constraint/routing warnings) shown as a small amber
 * indicator on the tile. Hover on desktop; tap on mobile (tap-away or Escape
 * dismisses). Sits OUTSIDE the expand button (no nested buttons), so a tap here
 * doesn't also open the schedule. The popover is position:fixed off the button's
 * rect so the panel's overflow-y-auto can't clip it near the list's bottom.
 */
function WarningBadge({ messages }: { messages: string[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const show = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const right = window.innerWidth - r.right;
    // Flip above the badge when there isn't room below (e.g. the mobile sheet).
    setPos(r.bottom + 140 > window.innerHeight ? { bottom: window.innerHeight - r.top + 6, right } : { top: r.bottom + 6, right });
    setOpen(true);
  };
  const hide = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        onMouseEnter={show}
        onMouseLeave={hide}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          if (open) hide();
          else show();
        }}
        className="flex h-5 w-5 items-center justify-center rounded-full text-accent hover:bg-accent/15"
        aria-label={`${messages.length} note${messages.length > 1 ? "s" : ""} about this runner`}
        aria-expanded={open}
      >
        <WarnIcon />
      </button>
      {open && pos && (
        <span
          role="tooltip"
          style={{ position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right }}
          className="z-[1100] w-56 space-y-1.5 rounded-lg border border-accent/30 bg-surface-mid px-3 py-2 text-left text-xs text-text shadow-panel"
        >
          {messages.map((m, i) => (
            <span key={i} className="block leading-snug">
              {m}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v7.5" />
      <path d="M4.8 7 8 10.2 11.2 7" />
      <path d="M3 13h10" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5 15 14H1L8 1.5Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6.2v3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r="0.85" fill="currentColor" />
    </svg>
  );
}
