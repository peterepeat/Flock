// ---------------------------------------------------------------------------
// Schedule builder — turns a timed route + companion intervals into an ordered
// list of plain-English schedule segments (run/rest, who you're with, pace,
// distance). The UI renders "flying with [name]" / "running solo" from this.
// ---------------------------------------------------------------------------

import { createLogger } from "./logger";
import type { ScheduleSegment } from "./types";
import type { CompanionInterval, TimedRoute } from "./routing-types";
import { secToTime } from "./units";

const log = createLogger("schedule");

export function buildSchedule(
  route: TimedRoute,
  intervals: CompanionInterval[],
): ScheduleSegment[] {
  const pts = route.points;
  const n = pts.length;
  if (n < 2) return [];

  // Per-point companion set + (slower) pace.
  const companionsAt: string[][] = Array.from({ length: n }, () => []);
  const paceAt: number[] = Array.from({ length: n }, () => route.paceSecPerKm);
  for (const iv of intervals) {
    for (let i = iv.startIdx; i <= iv.endIdx && i < n; i++) {
      if (!companionsAt[i].includes(iv.companionId)) companionsAt[i].push(iv.companionId);
      paceAt[i] = Math.max(paceAt[i], iv.paceSecPerKm);
    }
  }

  const sig = (i: number) => [...companionsAt[i]].sort().join(",");
  const restIdx = route.restInsertedAtIdx;
  const segments: ScheduleSegment[] = [];

  const emitRun = (sIdx: number, eIdx: number) => {
    if (eIdx <= sIdx) return;
    const companionIds = [...companionsAt[sIdx]].sort();
    let pace = route.paceSecPerKm;
    for (let i = sIdx; i < eIdx; i++) pace = Math.max(pace, paceAt[i]);
    segments.push({
      type: "run",
      startTime: secToTime(pts[sIdx].clockSec),
      endTime: secToTime(pts[eIdx].clockSec),
      startLocation: pts[sIdx].ll,
      endLocation: pts[eIdx].ll,
      paceSecPerKm: pace,
      companionIds,
      distanceKm: Number((pts[eIdx].cumKm - pts[sIdx].cumKm).toFixed(2)),
    });
  };

  const emitRest = (idx: number) => {
    segments.push({
      type: "rest",
      startTime: secToTime(pts[idx].clockSec),
      endTime: secToTime(pts[idx].clockSec + route.restDurationSec),
      startLocation: pts[idx].ll,
      endLocation: pts[idx].ll,
      paceSecPerKm: null,
      companionIds: [],
      distanceKm: 0,
    });
  };

  let segStart = 0;
  for (let i = 0; i < n - 1; i++) {
    const sigHere = sig(i);
    const sigNext = i + 1 <= n - 2 ? sig(i + 1) : null;
    const restBreakAtNext = restIdx != null && restIdx === i + 1;

    if (sigNext === null || sigNext !== sigHere || restBreakAtNext) {
      emitRun(segStart, i + 1);
      if (restBreakAtNext) emitRest(i + 1);
      segStart = i + 1;
    }
  }

  log.debug("schedule built", {
    participantId: route.participantId,
    segments: segments.length,
    rest: restIdx != null,
  });
  return segments;
}
