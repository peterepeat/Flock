"use client";

import { initial } from "@/lib/colors";
import { formatDistance, formatDuration, formatPaceShort } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

/**
 * Per-participant plain-English schedule. Conversational throughout — "flocking
 * with [name]" for together stretches, "running solo" for the rest, never
 * "shared segment". Together stretches are tinted in the co-runner's colour.
 */
export default function ScheduleView({ participantId }: { participantId: string }) {
  const session = useFlockStore((s) => s.session);
  if (!session) return null;

  const participant = session.participants.find((p) => p.id === participantId);
  const route = session.computedRoutes?.find((r) => r.participantId === participantId);
  const unit = session.unitPreference;

  const colorOf = (id: string) => session.participants.find((p) => p.id === id)?.color ?? "#fff";
  const nameOf = (id: string) => session.participants.find((p) => p.id === id)?.name ?? "someone";

  if (!participant) return null;

  if (!route) {
    return (
      <div className="mt-2 rounded-lg bg-surface px-3 py-2 text-xs text-text-dim">
        {participant.startLocation
          ? "Working out this route…"
          : "No route yet — add a starting point."}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1.5 rounded-lg bg-surface px-3 py-3">
      <Line time={route.departureTime} text="Leave home" emphasis />

      {route.schedule.map((seg, i) => {
        if (seg.type === "rest") {
          return (
            <div key={i} className="rounded-md bg-surface-lift/60 px-2 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="mono text-xs text-fog">
                  {seg.startTime}–{seg.endTime}
                </span>
                <span className="text-xs text-text">Coffee stop ☕</span>
              </div>
            </div>
          );
        }

        const withSomeone = seg.companionIds.length > 0;
        const tint = withSomeone ? colorOf(seg.companionIds[0]) : undefined;
        const who = seg.companionIds.map(nameOf).join(" + ");

        return (
          <div
            key={i}
            className="rounded-md px-2 py-1.5"
            style={
              withSomeone
                ? { background: `${tint}22`, borderLeft: `2px solid ${tint}` }
                : undefined
            }
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="mono text-xs text-fog">
                {seg.startTime}–{seg.endTime}
              </span>
              <span className="mono text-xs text-text-dim">
                {formatDistance(seg.distanceKm, unit)}
                {seg.paceSecPerKm ? ` · ${formatPaceShort(seg.paceSecPerKm, unit)}` : ""}
              </span>
            </div>
            <div className="mt-0.5 text-xs">
              {withSomeone ? (
                <span className="text-text">
                  Flocking with <span style={{ color: tint }}>{who}</span>
                </span>
              ) : (
                <span className="text-text-dim">Running solo</span>
              )}
            </div>
          </div>
        );
      })}

      <Line
        time={route.arrivalTime}
        text={`Home · ${formatDistance(route.distanceKm, unit)} · ${formatDuration(
          route.estimatedDurationMinutes,
        )} moving`}
        emphasis
      />
    </div>
  );
}

function Line({ time, text, emphasis }: { time: string; text: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 px-1">
      <span className="mono text-xs text-together">{time}</span>
      <span className={`text-xs ${emphasis ? "text-text" : "text-text-dim"}`}>{text}</span>
    </div>
  );
}
