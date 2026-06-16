"use client";

import { useEffect, useState } from "react";

import ScheduleView from "@/components/Panel/ScheduleView";
import { initial } from "@/lib/colors";
import { ownsParticipant } from "@/lib/editTokens";
import { formatDistance } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

export default function ParticipantList() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const openEditForm = useFlockStore((s) => s.openEditForm);
  const setHovered = useFlockStore((s) => s.setHovered);
  const expandedId = useFlockStore((s) => s.expandedParticipantId);
  const setExpanded = useFlockStore((s) => s.setExpanded);
  const locked = session?.lockedAt != null;

  // ownsParticipant reads localStorage — compute client-side after mount.
  const [owned, setOwned] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!session) return;
    const map: Record<string, boolean> = {};
    for (const p of session.participants) map[p.id] = ownsParticipant(flockId, p.id);
    setOwned(map);
  }, [session, flockId]);

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
        const isOwn = owned[p.id];
        const isExpanded = expandedId === p.id;
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
                  onClick={() => setExpanded(isExpanded ? null : p.id)}
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
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm text-text">{p.name}</span>
                      {isOwn && (
                        <span className="rounded bg-surface-lift px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fog">
                          you
                        </span>
                      )}
                    </span>
                    {route && (
                      <span className="mono block text-xs text-fog">
                        {formatDistance(route.distanceKm, session.unitPreference)} ·{" "}
                        {route.departureTime}–{route.arrivalTime}
                      </span>
                    )}
                  </span>
                </button>
                {isOwn && !locked && (
                  <button
                    type="button"
                    onClick={() => openEditForm(p.id)}
                    className="shrink-0 text-xs text-fog hover:text-text"
                  >
                    edit
                  </button>
                )}
                {locked && route && (
                  <a
                    href={`/api/gpx/${flockId}/${p.id}`}
                    className="shrink-0 rounded-full bg-together px-2.5 py-1 text-[11px] font-medium text-[#0c1413] hover:brightness-110"
                  >
                    Download
                  </a>
                )}
              </div>
              {isExpanded && (
                <div className="px-2 pb-2">
                  <ScheduleView participantId={p.id} />
                  {locked && route && (
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
