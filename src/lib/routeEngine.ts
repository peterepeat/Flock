// ---------------------------------------------------------------------------
// Route engine — the Together-Minutes model (flock-route + peel-off + clock).
//
//   build the shared backbone → each runner takes a [0, arc] interval on it
//   (converge at the rendezvous, peel off home at their budget) → one flock
//   clock (pace per leg = slowest present) → exact legs → Together-Minutes.
//
// Because the whole flock shares one position→time clock, spatial overlap IS
// temporal overlap, so legs are exact and there is no proximity guessing and no
// iterative distance padding. A runner with no distance limit matches the flock
// (does the whole backbone). The backbone auto-extends only as far as ≥2 runners
// can reach ("never solo on the backbone").
//
// v1 scope: everyone converges at a single rendezvous (km 0) and peels off
// forward. Per-person chosen entry points (Step 6) are a follow-up.
// ---------------------------------------------------------------------------

import { distanceMeters } from "./geo";
import { createLogger } from "./logger";
import {
  buildBackbone,
  centroid,
  pointAtKm,
  sliceKm,
  type Backbone,
} from "./flockRoute";
import { getRoute, RouteError, type OrsRoute } from "./ors";
import type {
  ComputedRoute,
  FlockSession,
  LatLng,
  Participant,
  ScheduleSegment,
  SharedSegment,
} from "./types";
import type { CalcWarning, PairSummary } from "./routing-types";
import {
  DEFAULT_DEPARTURE,
  DEFAULT_LOOP_DISTANCE_KM,
  DEFAULT_PACE_SEC_PER_KM,
  secToTime,
  timeToSec,
} from "./units";

const log = createLogger("route-engine");

const DEFAULT_BACKBONE_KM = 6; // when nobody has a distance limit
const EPS = 1e-6;

const round2 = (v: number) => Number(v.toFixed(2));
const crowKm = (a: LatLng, b: LatLng) => distanceMeters(a, b) / 1000;

/** Target distance (km) respecting any hard cap, or null if unconstrained. */
function targetDistanceKm(p: Participant): number | null {
  if (p.preferredDistance == null && p.maxDistance == null) return null;
  let t = p.preferredDistance ?? p.maxDistance ?? DEFAULT_LOOP_DISTANCE_KM;
  if (p.maxDistance != null) t = Math.min(t, p.maxDistance);
  return t;
}

const paceOf = (p: Participant) => p.preferredPace ?? DEFAULT_PACE_SEC_PER_KM;
const earliestOf = (p: Participant) => timeToSec(p.earliestStartTime ?? DEFAULT_DEPARTURE);

export interface CalcResult {
  routes: ComputedRoute[];
  sharedSegments: SharedSegment[];
  summary: { totalTogetherMinutes: number; pairwiseSummary: PairSummary[] };
  warnings: CalcWarning[];
  skipped: boolean;
}

// --- ORS cache --------------------------------------------------------------

const orsCache = new Map<string, OrsRoute>();
const round5 = (ll: LatLng) => `${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}`;

async function legRoute(a: LatLng, b: LatLng): Promise<OrsRoute> {
  const key = `p2p:${round5(a)};${round5(b)}`;
  const hit = orsCache.get(key);
  if (hit) return hit;
  const r = await getRoute([a, b]);
  orsCache.set(key, r);
  return r;
}

function toLineString(coords: LatLng[]): GeoJSON.LineString {
  return { type: "LineString", coordinates: coords.map((c) => [c.lng, c.lat]) };
}

// --- internal types ---------------------------------------------------------

interface RunnerBuild {
  p: Participant;
  ownPaceSec: number;
  earliestSec: number;
  home: LatLng;
  approachKm: number;
  approachGeom: LatLng[];
  arcKm: number;
  egressKm: number;
  egressGeom: LatLng[];
  departHomeSec: number; // absolute
  leaveBackboneSec: number; // flock-clock seconds at peel (incl. stops passed)
}

interface Leg {
  lo: number;
  hi: number;
  present: string[]; // participant ids
  paceSec: number | null; // null = rest
  startSec: number; // flock-clock seconds (from km 0)
  endSec: number;
  name?: string; // rest label
}

// --- legs / flock clock -----------------------------------------------------

/** Segment the backbone into legs by peel + stop boundaries (reads b.arcKm). */
function computeLegs(builds: RunnerBuild[], backbone: Backbone): Leg[] {
  const total = backbone.totalKm;
  const maxArc = Math.max(0, ...builds.map((b) => b.arcKm));
  const boundarySet = new Set<number>([0]);
  for (const b of builds) boundarySet.add(clampRound(b.arcKm, total));
  for (const s of backbone.stops) if (s.km <= maxArc + EPS) boundarySet.add(clampRound(s.km, total));
  const boundaries = [...boundarySet].filter((k) => k <= maxArc + EPS).sort((a, b) => a - b);

  const legs: Leg[] = [];
  let clock = 0;
  for (let k = 0; k < boundaries.length; k++) {
    const at = boundaries[k];
    const stop = backbone.stops.find((s) => Math.abs(s.km - at) < 1e-3);
    if (stop) {
      const here = builds.filter((x) => x.arcKm >= at - EPS);
      if (here.length > 0) {
        const startSec = clock;
        clock += stop.durationSec;
        legs.push({ lo: at, hi: at, present: here.map((x) => x.p.id), paceSec: null, startSec, endSec: clock, name: stop.name });
      }
    }
    if (k >= boundaries.length - 1) break;
    const lo = at;
    const hi = boundaries[k + 1];
    if (hi - lo < EPS) continue;
    const present = builds.filter((x) => x.arcKm >= hi - EPS);
    if (present.length === 0) continue;
    const paceSec = Math.max(...present.map((x) => x.ownPaceSec)); // slowest present
    const startSec = clock;
    clock += (hi - lo) * paceSec;
    legs.push({ lo, hi, present: present.map((x) => x.p.id), paceSec, startSec, endSec: clock });
  }
  return legs;
}

/** Flock-clock time (seconds from km 0) at an arc position, incl. stops passed. */
function tAtLegs(legs: Leg[], km: number): number {
  let best = 0;
  for (const lg of legs) {
    if (lg.paceSec == null) {
      if (lg.lo <= km + EPS) best = Math.max(best, lg.endSec);
      continue;
    }
    if (km >= lg.hi - EPS) best = Math.max(best, lg.endSec);
    else if (km > lg.lo) best = Math.max(best, lg.startSec + (km - lg.lo) * lg.paceSec);
  }
  return best;
}

/** Arrival home (abs seconds) if `b` peels at arc `a` (crow egress estimate). */
function arrivalEstimate(b: RunnerBuild, a: number, legs: Leg[], backbone: Backbone, T0abs: number): number {
  const egEst = crowKm(pointAtKm(backbone, a), b.home) * 1.3;
  return T0abs + tAtLegs(legs, a) + egEst * b.ownPaceSec;
}

/**
 * Trim arcs so anyone with a latest-finish makes it home in time. Tightest
 * deadline first; each trim only speeds up later legs (monotone), so one pass
 * converges. Re-fetches the egress geometry at each trimmed peel.
 */
async function trimForLatestFinish(builds: RunnerBuild[], backbone: Backbone, T0abs: number): Promise<void> {
  const timed = builds
    .filter((b) => b.p.latestFinishTime)
    .sort((a, b) => timeToSec(a.p.latestFinishTime!) - timeToSec(b.p.latestFinishTime!));

  for (const b of timed) {
    const latest = timeToSec(b.p.latestFinishTime!);
    const legs0 = computeLegs(builds, backbone);
    const curArrival = T0abs + tAtLegs(legs0, b.arcKm) + b.egressKm * b.ownPaceSec;
    if (curArrival <= latest + 60) continue; // 1 min slack

    let lo = 0;
    let hi = b.arcKm;
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      b.arcKm = mid; // computeLegs reads arcKm, so reflect the candidate
      const legs = computeLegs(builds, backbone);
      if (arrivalEstimate(b, mid, legs, backbone, T0abs) <= latest) lo = mid;
      else hi = mid;
    }
    b.arcKm = lo;

    try {
      const eg = await legRoute(pointAtKm(backbone, b.arcKm), b.home);
      b.egressKm = eg.distanceKm;
      b.egressGeom = (eg.geometry.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng }));
    } catch {
      /* keep prior egress */
    }
    log.info("trimmed for latest finish", {
      participantId: b.p.id,
      latest: secToTime(latest),
      arcKm: round2(b.arcKm),
    });
  }
}

// --- public entry -----------------------------------------------------------

export async function calculateRoutes(session: FlockSession): Promise<CalcResult> {
  const done = log.time("calculate", { flockId: session.id });
  const runners = session.participants.filter((p) => p.startLocation);
  const waypoints = session.waypoints ?? [];

  if (runners.length === 0) {
    done({ skipped: true });
    return empty(true);
  }

  // Rendezvous: first waypoint, else the centroid of starts.
  const rendezvous = waypoints[0]?.location ?? centroid(runners.map((p) => p.startLocation));

  // Approaches (home → rendezvous), in parallel.
  const approaches = await Promise.allSettled(
    runners.map((p) => legRoute(p.startLocation, rendezvous)),
  );

  const warnings: CalcWarning[] = [];
  const live: { p: Participant; approach: OrsRoute }[] = [];
  approaches.forEach((r, i) => {
    if (r.status === "fulfilled") live.push({ p: runners[i], approach: r.value });
    else {
      const code = r.reason instanceof RouteError ? r.reason.code : "ors-error";
      log.warn("approach failed", { participantId: runners[i].id, code });
      warnings.push({
        participantId: runners[i].id,
        message:
          code === "no-route"
            ? "We couldn't find a runnable route from your start — try moving your pin."
            : "Routes are taking longer than usual — trying again shortly.",
      });
    }
  });

  if (live.length === 0) {
    done({ skipped: true });
    return empty(true);
  }

  // Backbone length (auto only): the "never solo" reach = 2nd-largest arc the
  // runners could do (unconstrained = unbounded → they just match the longest).
  const arcEstimate = (p: Participant, approachKm: number): number => {
    const t = targetDistanceKm(p);
    return t == null ? Infinity : Math.max(0, t - 2 * approachKm);
  };
  const ests = live
    .map(({ p, approach }) => arcEstimate(p, approach.distanceKm))
    .sort((a, b) => b - a);
  const finite = ests.filter((e) => Number.isFinite(e));
  let targetKm: number;
  if (ests.length >= 2 && Number.isFinite(ests[1])) targetKm = ests[1];
  else if (finite.length) targetKm = Math.max(...finite);
  else targetKm = DEFAULT_BACKBONE_KM;
  targetKm = Math.max(1, targetKm);

  const backbone = await buildBackbone({
    waypoints,
    starts: live.map((l) => l.p.startLocation),
    targetKm,
  });
  const total = backbone.totalKm;

  // Each runner's arc = how far along the backbone they go before peeling.
  // (egress is estimated as ≈ approach to set the arc; the real egress geometry
  // is fetched at the resulting peel point.)
  const builds: RunnerBuild[] = [];
  for (const { p, approach } of live) {
    const t = targetDistanceKm(p);
    // Pick the FURTHEST peel that still fits the budget (so a runner stays with
    // the flock as long as possible without overshooting). Egress is estimated
    // by crow-distance × road factor during the scan (no extra ORS calls); the
    // scan naturally favours points where the loop returns near home.
    let arcKm: number;
    if (t == null) {
      arcKm = total;
    } else {
      const hiArc = Math.min(total, Math.max(0, t - approach.distanceKm));
      arcKm = 0;
      const steps = 24;
      for (let s = 1; s <= steps; s++) {
        const a = (hiArc * s) / steps;
        const egEst = crowKm(pointAtKm(backbone, a), p.startLocation) * 1.3;
        if (approach.distanceKm + a + egEst <= t + EPS) arcKm = a;
      }
    }
    const peel = pointAtKm(backbone, arcKm);
    let egress: OrsRoute;
    try {
      egress = await legRoute(peel, p.startLocation);
    } catch {
      egress = approach; // fallback: reuse approach geometry/distance
    }
    builds.push({
      p,
      ownPaceSec: paceOf(p),
      earliestSec: earliestOf(p),
      home: p.startLocation,
      approachKm: approach.distanceKm,
      approachGeom: (approach.geometry.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng })),
      arcKm,
      egressKm: egress.distanceKm,
      egressGeom: (egress.geometry.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng })),
      departHomeSec: 0,
      leaveBackboneSec: 0,
    });
  }

  // Global anchor: flock at km 0 when everyone can have arrived (depends only on
  // earliest-start + approach, so it's fixed before trimming).
  const T0abs = Math.max(...builds.map((b) => b.earliestSec + b.approachKm * b.ownPaceSec));

  // Latest-finish: trim arcs (peel earlier) for anyone who'd otherwise finish
  // late. Monotone — trimming a slow runner only speeds up later legs — so one
  // tightest-first pass converges without re-provoking route changes.
  await trimForLatestFinish(builds, backbone, T0abs);

  const legs = computeLegs(builds, backbone);
  const tAt = (km: number) => tAtLegs(legs, km);

  for (const b of builds) {
    b.leaveBackboneSec = tAt(b.arcKm);
    b.departHomeSec = T0abs - b.approachKm * b.ownPaceSec;
  }
  const maxArc = Math.max(...builds.map((b) => b.arcKm));

  log.info("flock plan", {
    flockId: session.id,
    runners: builds.length,
    backboneKm: round2(total),
    maxArc: round2(maxArc),
    legs: legs.length,
    rendezvousAt: secToTime(T0abs),
  });

  // --- Assemble per-runner ComputedRoutes + schedules -----------------------
  const idToName = new Map(builds.map((b) => [b.p.id, b.p.name]));
  const routes: ComputedRoute[] = builds.map((b) => buildComputed(b, backbone, legs, T0abs));

  // --- Shared segments (run legs with ≥2 present) ---------------------------
  const sharedSegments: SharedSegment[] = legs
    .filter((lg) => lg.paceSec != null && lg.present.length >= 2)
    .map((lg) => ({
      participantIds: lg.present,
      geometry: toLineString(sliceKm(backbone, lg.lo, lg.hi)),
      overlapMinutes: round2((lg.endSec - lg.startSec) / 60),
      startTime: secToTime(T0abs + lg.startSec),
    }));

  // --- Together-Minutes + pairwise summary ----------------------------------
  let totalTogetherWallMin = 0;
  const pairMin = new Map<string, number>();
  const pairCount = new Map<string, number>();
  let systemTM = 0;
  for (const lg of legs) {
    const durMin = (lg.endSec - lg.startSec) / 60;
    const n = lg.present.length;
    if (n >= 2) {
      totalTogetherWallMin += durMin;
      systemTM += durMin * n * (n - 1);
      for (let i = 0; i < lg.present.length; i++)
        for (let j = i + 1; j < lg.present.length; j++) {
          const key = [lg.present[i], lg.present[j]].sort().join("|");
          pairMin.set(key, (pairMin.get(key) ?? 0) + durMin);
          if (lg.paceSec != null) pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
    }
  }
  const pairwiseSummary: PairSummary[] = [...pairMin.entries()].map(([key, min]) => {
    const [a, b] = key.split("|");
    return {
      participantA: a,
      participantB: b,
      togetherMinutes: round2(min),
      togetherStretchCount: pairCount.get(key) ?? 0,
    };
  });

  // --- Warnings -------------------------------------------------------------
  for (const b of builds) warnings.push(...buildWarnings(b, idToName));

  done({
    routes: routes.length,
    sharedSegments: sharedSegments.length,
    togetherWallMin: round2(totalTogetherWallMin),
    systemTogetherMinutes: round2(systemTM),
  });

  return {
    routes,
    sharedSegments,
    summary: { totalTogetherMinutes: round2(totalTogetherWallMin), pairwiseSummary },
    warnings,
    skipped: false,
  };
}

// --- helpers ----------------------------------------------------------------

function clampRound(km: number, total: number): number {
  return Math.max(0, Math.min(km, total));
}

function buildComputed(
  b: RunnerBuild,
  backbone: Backbone,
  legs: Leg[],
  T0abs: number,
): ComputedRoute {
  const arc = b.arcKm;
  const backboneSlice = sliceKm(backbone, 0, arc);
  const fullGeom = [...b.approachGeom, ...backboneSlice, ...b.egressGeom];

  const distanceKm = b.approachKm + arc + b.egressKm;
  const departHome = b.departHomeSec;
  const arrival = T0abs + b.leaveBackboneSec + b.egressKm * b.ownPaceSec;
  const movingSec = arrival - departHome; // includes any shared stops

  const schedule: ScheduleSegment[] = [];

  // Solo approach.
  if (b.approachKm > 0.02) {
    schedule.push({
      type: "run",
      startTime: secToTime(departHome),
      endTime: secToTime(T0abs),
      startLocation: b.home,
      endLocation: backbone.rendezvous,
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.approachKm),
    });
  }

  // Backbone legs this runner is part of.
  for (const lg of legs) {
    if (lg.hi > arc + EPS && lg.paceSec != null) continue; // beyond their peel
    if (!lg.present.includes(b.p.id)) continue;
    const companions = lg.present.filter((id) => id !== b.p.id);
    if (lg.paceSec == null) {
      schedule.push({
        type: "rest",
        startTime: secToTime(T0abs + lg.startSec),
        endTime: secToTime(T0abs + lg.endSec),
        startLocation: pointAtKm(backbone, lg.lo),
        endLocation: pointAtKm(backbone, lg.lo),
        paceSecPerKm: null,
        companionIds: companions,
        distanceKm: 0,
        label: lg.name,
      });
    } else {
      schedule.push({
        type: "run",
        startTime: secToTime(T0abs + lg.startSec),
        endTime: secToTime(T0abs + lg.endSec),
        startLocation: pointAtKm(backbone, lg.lo),
        endLocation: pointAtKm(backbone, lg.hi),
        paceSecPerKm: lg.paceSec,
        companionIds: companions,
        distanceKm: round2(lg.hi - lg.lo),
      });
    }
  }

  // Solo egress.
  if (b.egressKm > 0.02) {
    schedule.push({
      type: "run",
      startTime: secToTime(T0abs + b.leaveBackboneSec),
      endTime: secToTime(arrival),
      startLocation: pointAtKm(backbone, arc),
      endLocation: b.home,
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.egressKm),
    });
  }

  return {
    participantId: b.p.id,
    waypoints: [b.home, backbone.rendezvous, b.home],
    geometry: toLineString(fullGeom),
    distanceKm: round2(distanceKm),
    estimatedDurationMinutes: Math.round(movingSec / 60),
    departureTime: secToTime(departHome),
    arrivalTime: secToTime(arrival),
    schedule,
  };
}

function buildWarnings(b: RunnerBuild, names: Map<string, string>): CalcWarning[] {
  const out: CalcWarning[] = [];
  const distanceKm = b.approachKm + b.arcKm + b.egressKm;
  const target = targetDistanceKm(b.p);

  if (b.p.earliestStartTime && b.p.latestFinishTime) {
    const availableMin = (timeToSec(b.p.latestFinishTime) - timeToSec(b.p.earliestStartTime)) / 60;
    const requiredMin = (distanceKm * b.ownPaceSec) / 60;
    if (availableMin > 0 && requiredMin > availableMin + 1) {
      out.push({
        participantId: b.p.id,
        message: `At your pace, ${distanceKm.toFixed(1)}km takes about ${Math.round(
          requiredMin,
        )} min — but you've only got ${Math.round(availableMin)} min. Adjust one or the other.`,
      });
    }
  }

  // A lot of solo travel relative to the run.
  if (b.arcKm > 0 && b.approachKm + b.egressKm > b.arcKm) {
    out.push({
      participantId: b.p.id,
      message: "You're a bit far from the flock's path — more of your run is getting there and back than with the flock.",
    });
  }

  // Wanted more distance than the shared backbone offers.
  if (target != null && distanceKm + 1.5 < target) {
    out.push({
      participantId: b.p.id,
      message: `We kept the flock together — your route's about ${distanceKm.toFixed(
        1,
      )}km, a bit under your ${target}km. Add a waypoint to stretch it out.`,
    });
  }

  return out;
}

function empty(skipped: boolean): CalcResult {
  return {
    routes: [],
    sharedSegments: [],
    summary: { totalTogetherMinutes: 0, pairwiseSummary: [] },
    warnings: [],
    skipped,
  };
}
