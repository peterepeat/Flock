"use client";

import { formatDuration } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

/**
 * The primary metric of the whole product: total minutes the flock spends
 * together. Populated from build step 7 onward; until then it shows a gentle
 * prompt once there are routes to compare.
 */
export default function TogetherStat() {
  const session = useFlockStore((s) => s.session);
  if (!session) return null;

  const shared = session.sharedSegments ?? [];
  const totalMinutes = shared.reduce((sum, s) => sum + s.overlapMinutes, 0);
  const stretches = shared.length;
  const withDetails = session.participants.length;

  // Staggered starts: everyone leaves home at their own time so they converge on
  // the flock together. Only worth saying when departures actually differ.
  const routes = session.computedRoutes ?? [];
  const staggered = new Set(routes.map((r) => r.departureTime)).size > 1;

  if (totalMinutes === 0) {
    return (
      <div className="rounded-xl bg-surface p-4">
        <p className="text-sm text-text-dim">
          {withDetails < 2
            ? "Add another person to see where your routes overlap."
            : "Working out where you flock together…"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="rounded-xl bg-together-glow p-4">
        <div className="mono text-3xl font-medium text-together">
          {formatDuration(totalMinutes)}
        </div>
        <div className="text-sm text-text">flocking together</div>
        <div className="mt-1 text-xs text-fog">
          {stretches} {stretches === 1 ? "stretch" : "stretches"} together
        </div>
        {staggered && (
          <p className="mt-2 border-t border-together/15 pt-2 text-xs leading-snug text-fog">
            Staggered starts — you each set off at your own time to meet up together.
          </p>
        )}
      </div>
    </div>
  );
}
