"use client";

import { useEffect, useState } from "react";

import { initial } from "@/lib/colors";
import { ownsParticipant } from "@/lib/editTokens";
import { formatDistance } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

export default function ParticipantList() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const openEditForm = useFlockStore((s) => s.openEditForm);
  const setHovered = useFlockStore((s) => s.setHovered);
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
        return (
          <li key={p.id}>
            <button
              type="button"
              onMouseEnter={() => setHovered(p.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => isOwn && !locked && openEditForm(p.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-surface-lift ${
                isOwn && !locked ? "cursor-pointer" : "cursor-default"
              }`}
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
              {isOwn && !locked && (
                <span className="text-xs text-fog">edit</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
