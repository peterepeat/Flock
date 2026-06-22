// ---------------------------------------------------------------------------
// Flock — project a Plan onto the app's render contract (CalcResult): per-runner
// ComputedRoute (geometry slice + connector legs + a timed schedule), the shared
// segments the map glows, the spine, and per-waypoint ETAs. Pure — geometry only.
//
// The OUTPUT types (ComputedRoute/SharedSegment/ScheduleSegment) are the stable UI seam
// and don't change; this is where the clean Plan meets the existing renderer.
// ---------------------------------------------------------------------------

import type { ComputedRoute, LatLng, ScheduleSegment, SharedSegment } from "../types";
import type { CalcWarning, PairSummary } from "../routing-types";
import { secToTime } from "../units";
import type { Block, Plan, Route, Runner } from "./model";
import { arrivalAt } from "./plan";
import { pointAtKm, sliceKm, nearestKm } from "./route";

export interface FlockCalcResult {
  routes: ComputedRoute[];
  sharedSegments: SharedSegment[];
  flockRoute: GeoJSON.LineString | null;
  waypointEtas: Record<string, string> | null;
  summary: { totalTogetherMinutes: number; pairwiseSummary: PairSummary[] };
  warnings: CalcWarning[];
  skipped: boolean;
}

const toLine = (coords: LatLng[]): GeoJSON.LineString => ({
  type: "LineString",
  coordinates: coords.map((c) => [c.lng, c.lat]),
});
const round2 = (v: number) => Number(v.toFixed(2));

export interface Connectors {
  approach?: LatLng[]; // home → enter (manual start pin); absent for auto/waypoint
  egress?: LatLng[]; // exit → home (manual finish pin)
}

export function projectPlan(input: {
  plan: Plan;
  route: Route;
  runners: Runner[];
  waypoints: { id: string; location: LatLng }[];
  connectors?: Map<string, Connectors>;
}): FlockCalcResult {
  const { plan, route, runners, waypoints, connectors } = input;
  const stopName = (km: number) => route.stops.find((s) => Math.abs(s.km - km) < 1e-3)?.name;

  // --- per-runner routes + schedules ---
  const routes: ComputedRoute[] = plan.runners.map((p) => {
    const r = runners.find((x) => x.id === p.id)!;
    const conn = connectors?.get(p.id);
    const slice = sliceKm(route, p.enterKm, p.exitKm);
    const enterPt = pointAtKm(route, p.enterKm);
    const exitPt = pointAtKm(route, p.exitKm);
    const startPt = conn?.approach?.[0] ?? enterPt;
    const finishPt = conn?.egress?.[conn.egress.length - 1] ?? exitPt;

    const schedule: ScheduleSegment[] = [];
    if (conn?.approach && conn.approach.length >= 2 && r.connectorKm > 0.02) {
      schedule.push({
        type: "run", startTime: secToTime(p.departSec), endTime: secToTime(arrivalAt(plan.blocks, p.enterKm)),
        startLocation: startPt, endLocation: enterPt, paceSecPerKm: r.pace, companionIds: [], distanceKm: round2(r.connectorKm),
      });
    }
    for (const b of plan.blocks) {
      if (!b.members.includes(p.id)) continue;
      const companions = b.members.filter((id) => id !== p.id);
      schedule.push(
        b.paceSec == null
          ? { type: "rest", startTime: secToTime(b.startSec), endTime: secToTime(b.endSec), startLocation: pointAtKm(route, b.loKm), endLocation: pointAtKm(route, b.loKm), paceSecPerKm: null, companionIds: companions, distanceKm: 0, label: stopName(b.loKm) }
          : { type: "run", startTime: secToTime(b.startSec), endTime: secToTime(b.endSec), startLocation: pointAtKm(route, b.loKm), endLocation: pointAtKm(route, b.hiKm), paceSecPerKm: b.paceSec, companionIds: companions, distanceKm: round2(b.hiKm - b.loKm) },
      );
    }
    if (conn?.egress && conn.egress.length >= 2 && r.connectorKm > 0.02) {
      schedule.push({
        type: "run", startTime: secToTime(arrivalAt(plan.blocks, p.exitKm)), endTime: secToTime(p.arriveSec),
        startLocation: exitPt, endLocation: finishPt, paceSecPerKm: r.pace, companionIds: [], distanceKm: round2(r.connectorKm),
      });
    }

    // A runner who fits no participation (zero-span window — e.g. an earliest-start after the
    // flock finishes, or a degenerate pin) still needs a non-empty schedule so consumers never
    // choke: a single 0-distance marker at their point. They're already flagged by a warning.
    if (schedule.length === 0) {
      schedule.push({ type: "run", startTime: secToTime(p.departSec), endTime: secToTime(p.arriveSec), startLocation: startPt, endLocation: finishPt, paceSecPerKm: r.pace, companionIds: [], distanceKm: round2(p.distanceKm) });
    }

    const geometry = [...(conn?.approach ?? []), ...slice, ...(conn?.egress ?? [])];
    return {
      participantId: p.id,
      waypoints: [startPt, enterPt, exitPt, finishPt],
      geometry: toLine(geometry),
      distanceKm: round2(p.distanceKm),
      estimatedDurationMinutes: Math.round((p.arriveSec - p.departSec) / 60),
      departureTime: secToTime(p.departSec),
      arrivalTime: secToTime(p.arriveSec),
      schedule,
    };
  });

  // --- shared segments — moving stretches AND stops. A dwell counts as together-time
  // (the café reunion is the point), so it's emitted too, as a zero-length segment at the
  // stop; the map ignores the empty geometry but the displayed total includes it. Join
  // detection (the "meet here" diamond) tracks the previous MOVING block so a dwell
  // doesn't reset it. ---
  const sharedSegments: SharedSegment[] = [];
  let prevMembers: string[] = [];
  for (const b of plan.blocks) {
    if (b.members.length >= 2) {
      const joined = b.members.some((id) => !prevMembers.includes(id));
      const geometry = b.paceSec == null
        ? toLine([pointAtKm(route, b.loKm), pointAtKm(route, b.loKm)])
        : toLine(sliceKm(route, b.loKm, b.hiKm));
      sharedSegments.push({
        participantIds: b.members,
        geometry,
        overlapMinutes: round2((b.endSec - b.startSec) / 60),
        startTime: secToTime(b.startSec),
        isConvergence: joined,
      });
    }
    if (b.paceSec != null) prevMembers = b.members;
  }

  // --- together-time summary (wall minutes for display; pairwise per pair) ---
  let wallMin = 0;
  const pairMin = new Map<string, number>();
  const pairCount = new Map<string, number>();
  for (const b of plan.blocks) {
    const n = b.members.length;
    if (n < 2) continue;
    const durMin = (b.endSec - b.startSec) / 60;
    wallMin += durMin;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const key = [b.members[i], b.members[j]].sort().join("|");
        pairMin.set(key, (pairMin.get(key) ?? 0) + durMin);
        if (b.paceSec != null) pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
  }
  const pairwiseSummary: PairSummary[] = [...pairMin.entries()].map(([key, min]) => {
    const [a, b] = key.split("|");
    return { participantA: a, participantB: b, togetherMinutes: round2(min), togetherStretchCount: pairCount.get(key) ?? 0 };
  });

  // --- waypoint ETAs ---
  const maxExit = Math.max(0, ...plan.runners.map((p) => p.exitKm));
  const waypointEtas: Record<string, string> = {};
  for (const w of waypoints) {
    const km = nearestKm(route, w.location);
    if (km > maxExit + 0.05) continue;
    waypointEtas[w.id] = secToTime(arrivalAt(plan.blocks, km));
  }

  return {
    routes,
    sharedSegments,
    flockRoute: toLine(route.coords),
    waypointEtas: Object.keys(waypointEtas).length ? waypointEtas : null,
    summary: { totalTogetherMinutes: round2(wallMin), pairwiseSummary },
    warnings: plan.warnings.map((w) => ({ participantId: w.id, message: w.message })),
    skipped: false,
  };
}
