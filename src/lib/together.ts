// ---------------------------------------------------------------------------
// Together-time analysis — the novel algorithm at the heart of Flock.
//
// Two people "fly together" on a stretch only if they are within ~50m AND
// within a ~10-minute time window (the time check is essential — otherwise a
// north-in-the-morning runner and a south-in-the-afternoon runner on the same
// path would be flagged as together, which is wrong).
//
// Pipeline (per pair A,B):
//   1. spatial+temporal proximity scan → candidate together-moments
//   2. cluster spatially-contiguous candidates → together-stretches
//   3. sum stretch durations → together-minutes for the pair
//
// Everything is logged densely: pair sizes, candidate counts, stretch counts,
// per-pair minutes and total. This is the most fault-prone logic, so it is the
// most instrumented.
// ---------------------------------------------------------------------------

import { distanceMeters } from "./geo";
import { createLogger } from "./logger";
import type { SharedSegment } from "./types";
import type { CompanionInterval, PairSummary, TimedRoute } from "./routing-types";
import { secToTime } from "./units";

const log = createLogger("together");

// Tuning knobs (documented in the spec).
export const PROXIMITY_M = 50;
export const TIME_WINDOW_SEC = 10 * 60;
export const CLUSTER_GAP_M = 100;
const MIN_STRETCH_POINTS = 2;

export interface TogetherResult {
  shared: SharedSegment[];
  pairwise: PairSummary[];
  /** participantId → intervals on that participant's own route. */
  companionIntervals: Map<string, CompanionInterval[]>;
  totalTogetherMinutes: number;
}

interface Candidate {
  ia: number;
  ib: number;
  clockSec: number;
}

export function analyzeTogether(routes: TimedRoute[]): TogetherResult {
  const done = log.time("analyze", { routes: routes.length });
  const shared: SharedSegment[] = [];
  const pairwise: PairSummary[] = [];
  const companionIntervals = new Map<string, CompanionInterval[]>();
  for (const r of routes) companionIntervals.set(r.participantId, []);

  let total = 0;

  for (let a = 0; a < routes.length; a++) {
    for (let b = a + 1; b < routes.length; b++) {
      const A = routes[a];
      const B = routes[b];
      const plog = log.child(`${A.participantId.slice(0, 4)}-${B.participantId.slice(0, 4)}`);

      // 1. proximity scan
      const candidates = scanProximity(A, B, plog);
      if (candidates.length === 0) {
        plog.debug("no candidates (too far apart in space/time)");
        pairwise.push({
          participantA: A.participantId,
          participantB: B.participantId,
          togetherMinutes: 0,
          togetherStretchCount: 0,
        });
        continue;
      }

      // 2. cluster into stretches
      const stretches = clusterStretches(A, candidates, plog);

      // 3. build shared segments + intervals + minutes
      const sharedPace = Math.max(A.paceSecPerKm, B.paceSecPerKm); // slower of the two
      let pairMinutes = 0;
      for (const st of stretches) {
        const pts = A.points.slice(st.iaStart, st.iaEnd + 1);
        if (pts.length < MIN_STRETCH_POINTS) continue;

        const aStartClock = A.points[st.iaStart].clockSec;
        const aEndClock = A.points[st.iaEnd].clockSec;
        const overlapMinutes = Math.max(0, (aEndClock - aStartClock) / 60);
        const startClock = Math.min(aStartClock, B.points[st.ibStart].clockSec);
        pairMinutes += overlapMinutes;

        shared.push({
          participantIds: [A.participantId, B.participantId],
          geometry: {
            type: "LineString",
            coordinates: pts.map((p) => [p.ll.lng, p.ll.lat]),
          },
          overlapMinutes: Number(overlapMinutes.toFixed(1)),
          startTime: secToTime(startClock),
        });

        companionIntervals.get(A.participantId)!.push({
          startIdx: st.iaStart,
          endIdx: st.iaEnd,
          companionId: B.participantId,
          paceSecPerKm: sharedPace,
        });
        companionIntervals.get(B.participantId)!.push({
          startIdx: st.ibStart,
          endIdx: st.ibEnd,
          companionId: A.participantId,
          paceSecPerKm: sharedPace,
        });
      }

      pairMinutes = Number(pairMinutes.toFixed(1));
      total += pairMinutes;
      plog.info("pair analysed", {
        candidates: candidates.length,
        stretches: stretches.length,
        togetherMinutes: pairMinutes,
      });
      pairwise.push({
        participantA: A.participantId,
        participantB: B.participantId,
        togetherMinutes: pairMinutes,
        togetherStretchCount: stretches.length,
      });
    }
  }

  total = Number(total.toFixed(1));
  done({ sharedSegments: shared.length, totalTogetherMinutes: total });
  return { shared, pairwise, companionIntervals, totalTogetherMinutes: total };
}

/** For each A point, find the nearest B point within PROXIMITY_M and TIME_WINDOW. */
function scanProximity(A: TimedRoute, B: TimedRoute, plog: ReturnType<typeof log.child>): Candidate[] {
  const candidates: Candidate[] = [];
  for (let ia = 0; ia < A.points.length; ia++) {
    const pa = A.points[ia];
    let bestIb = -1;
    let bestDist = PROXIMITY_M;
    for (let ib = 0; ib < B.points.length; ib++) {
      const pb = B.points[ib];
      // Cheap time gate first.
      if (Math.abs(pa.clockSec - pb.clockSec) > TIME_WINDOW_SEC) continue;
      const d = distanceMeters(pa.ll, pb.ll);
      if (d < bestDist) {
        bestDist = d;
        bestIb = ib;
      }
    }
    if (bestIb >= 0) {
      candidates.push({ ia, ib: bestIb, clockSec: pa.clockSec });
    }
  }
  plog.debug("proximity scan", {
    aPoints: A.points.length,
    bPoints: B.points.length,
    candidates: candidates.length,
  });
  return candidates;
}

interface Stretch {
  iaStart: number;
  iaEnd: number;
  ibStart: number;
  ibEnd: number;
}

/** Cluster candidates that are spatially contiguous along A (gaps ≤ CLUSTER_GAP_M). */
function clusterStretches(
  A: TimedRoute,
  candidates: Candidate[],
  plog: ReturnType<typeof log.child>,
): Stretch[] {
  const stretches: Stretch[] = [];
  let cur: Stretch | null = null;
  let ibMin = Infinity;
  let ibMax = -Infinity;

  for (let k = 0; k < candidates.length; k++) {
    const c = candidates[k];
    if (cur === null) {
      cur = { iaStart: c.ia, iaEnd: c.ia, ibStart: c.ib, ibEnd: c.ib };
      ibMin = c.ib;
      ibMax = c.ib;
      continue;
    }
    const prevPt = A.points[cur.iaEnd].ll;
    const gap = distanceMeters(prevPt, A.points[c.ia].ll);
    if (gap <= CLUSTER_GAP_M) {
      cur.iaEnd = c.ia;
      ibMin = Math.min(ibMin, c.ib);
      ibMax = Math.max(ibMax, c.ib);
    } else {
      cur.ibStart = ibMin;
      cur.ibEnd = ibMax;
      stretches.push(cur);
      cur = { iaStart: c.ia, iaEnd: c.ia, ibStart: c.ib, ibEnd: c.ib };
      ibMin = c.ib;
      ibMax = c.ib;
    }
  }
  if (cur) {
    cur.ibStart = ibMin;
    cur.ibEnd = ibMax;
    stretches.push(cur);
  }

  plog.debug("clustered", { stretches: stretches.length });
  return stretches.filter((s) => s.iaEnd > s.iaStart);
}
