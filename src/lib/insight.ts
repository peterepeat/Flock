// ---------------------------------------------------------------------------
// Flock insight — the marginal-value certificate.
//
// Each person edits their OWN constraints behind a per-device edit token, so the
// group never sees each other's caps/deadlines. That hides WHY the flock is shaped
// the way it is: usually one person's distance cap or finish-time deadline is what
// makes the group split first. This derives that bottleneck from the (persisted)
// computed routes + the shared participant constraints, so it can be surfaced.
//
// Pure + client-safe — re-derived from the session on every render, so it survives a
// reload without any new persisted field.
// ---------------------------------------------------------------------------

import type { FlockSession } from "./types";
import { formatDistance, timeToSec } from "./units";

export interface FlockInsight {
  participantId: string;
  message: string; // the phrased certificate, e.g. "Maya is capped at 10 km, so …"
}

/** The flock-clock time a runner LAST has company — when they peel off the flock. */
function peelOffTime(schedule: { companionIds: string[]; endTime: string }[]): string | null {
  let last: string | null = null;
  for (const seg of schedule) if (seg.companionIds.length > 0) last = seg.endTime;
  return last;
}

/**
 * The binding constraint that limits the flock's time together: the runner who peels
 * off first, why (their distance cap / finish deadline / distance goal), and how much
 * longer the rest stay together without them. Returns null when there's no meaningful
 * split (everyone finishes the shared route together, or fewer than two ever flock).
 */
export function flockInsight(session: FlockSession): FlockInsight | null {
  const routes = session.computedRoutes ?? [];
  if (routes.length < 2) return null;
  const byId = new Map(session.participants.map((p) => [p.id, p]));

  const peels = routes
    .map((r) => ({ r, leave: peelOffTime(r.schedule) }))
    .filter((x): x is { r: (typeof routes)[number]; leave: string } => x.leave != null);
  if (peels.length < 2) return null;

  // The flock fully disperses at the LAST peel-off; the bottleneck is the EARLIEST.
  const latest = peels.reduce((m, x) => (timeToSec(x.leave) > timeToSec(m) ? x.leave : m), peels[0].leave);
  const early = peels.filter((x) => timeToSec(x.leave) < timeToSec(latest) - 30);
  if (early.length === 0) return null; // everyone leaves together → no bottleneck
  const first = early.reduce((a, b) => (timeToSec(b.leave) < timeToSec(a.leave) ? b : a));

  const costMin = Math.round((timeToSec(latest) - timeToSec(first.leave)) / 60);
  if (costMin < 5) return null; // a near-simultaneous split isn't worth calling out

  const p = byId.get(first.r.participantId);
  if (!p) return null;
  const name = p.name?.trim() || "Someone";
  const unit = session.unitPreference;

  // Why are they first to leave? Prefer the tightest HARD limit (deadline / cap), the
  // ones the rest of the group can't see; fall back to a soft distance goal.
  let reason: string | null = null;
  if (p.latestFinishTime && Math.abs(timeToSec(first.r.arrivalTime) - timeToSec(p.latestFinishTime)) <= 360) {
    reason = `needs to be done by ${p.latestFinishTime}`;
  } else if (p.maxDistance != null && first.r.distanceKm >= p.maxDistance - 0.8) {
    reason = `is capped at ${formatDistance(p.maxDistance, unit)}`;
  } else if (p.preferredDistance != null) {
    reason = `is aiming for about ${formatDistance(p.preferredDistance, unit)}`;
  }
  if (!reason) return null;

  return {
    participantId: p.id,
    message: `${name} ${reason}, so they peel off first — the rest of you carry on about ${costMin} min more together.`,
  };
}
