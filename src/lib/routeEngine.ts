// ---------------------------------------------------------------------------
// Route engine — the Together-Minutes model (flock-route + flock-clock).
//
//   build the shared backbone → each runner picks a [enter, exit] window on it
//   that maximises THEIR together-minutes within budget (best-response) → one
//   flock clock (pace per leg = slowest present) → exact legs → Together-Minutes.
//
// Entry AND exit are free variables. Each runner best-responds against the
// route's company-density profile; because together-minutes is symmetric (if
// I'm with you we both bank it), selfish best-response is positive-sum and the
// iteration converges to a local max of total Together-Minutes. Behaviours
// emerge from budgets + geometry: an anchor (budget ≥ whole route) takes the
// whole route; a joiner takes a near-home arc; a clustered auto-flock converges.
//
// One flock clock means spatial overlap IS temporal overlap, so legs are exact —
// no proximity guessing, no iterative distance padding.
// ---------------------------------------------------------------------------

import { distanceMeters } from "./geo";
import { createLogger } from "./logger";
import { buildBackbone, centroid, nearestKm, pointAtKm, sliceKm, type Backbone } from "./flockRoute";
import { getRoundTrip, getRoute, RouteError, type OrsRoute } from "./ors";
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

const DEFAULT_BACKBONE_KM = 6;
const ROAD_FACTOR = 1.3; // crow-flies → on-path estimate for approach/egress
const EPS = 1e-6;
// Solo extension: the backbone reaches only as far as the SECOND-longest runner
// (the "never solo on the backbone" invariant). The single longest's surplus
// distance — when it clears this margin — becomes a solo tail past the peel-off.
const MIN_EXTENSION_KM = 1.5;

const round2 = (v: number) => Number(v.toFixed(2));
const crowKm = (a: LatLng, b: LatLng) => distanceMeters(a, b) / 1000;

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
  flockRoute: GeoJSON.LineString | null; // the shared backbone spine, for the map
  waypointEtas: Record<string, string> | null; // waypointId → "HH:MM" the flock passes
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
const geomToLatLng = (g: GeoJSON.LineString): LatLng[] =>
  (g.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng }));

// --- internal types ---------------------------------------------------------

interface RunnerBuild {
  p: Participant;
  ownPaceSec: number;
  earliestSec: number;
  home: LatLng;
  enterKm: number;
  exitKm: number;
  approachKm: number;
  approachGeom: LatLng[];
  egressKm: number;
  egressGeom: LatLng[];
  departHomeSec: number;
  enterClockSec: number; // flock-clock secs at enter
  exitClockSec: number; // flock-clock secs at exit (incl. stops passed)
  extensionKm: number; // solo distance run past the peel-off (0 = none)
  extensionGeom: LatLng[]; // its geometry (a loop from the exit point back to it)
}

interface Leg {
  lo: number;
  hi: number;
  present: string[];
  paceSec: number | null; // null = rest
  startSec: number;
  endSec: number;
  name?: string;
}

const clampRound = (km: number, total: number) => Math.max(0, Math.min(km, total));

// --- legs / flock clock (works for arbitrary [enter, exit] windows) ---------

function computeLegs(builds: RunnerBuild[], backbone: Backbone): Leg[] {
  const total = backbone.totalKm;
  const maxExit = Math.max(0, ...builds.map((b) => b.exitKm));
  const boundarySet = new Set<number>([0]);
  for (const b of builds) {
    boundarySet.add(clampRound(b.enterKm, total));
    boundarySet.add(clampRound(b.exitKm, total));
  }
  for (const s of backbone.stops) if (s.km <= maxExit + EPS) boundarySet.add(clampRound(s.km, total));
  const boundaries = [...boundarySet].filter((k) => k <= maxExit + EPS).sort((a, b) => a - b);

  const covers = (b: RunnerBuild, lo: number, hi: number) =>
    b.enterKm <= lo + EPS && b.exitKm >= hi - EPS;

  const legs: Leg[] = [];
  let clock = 0;
  for (let k = 0; k < boundaries.length; k++) {
    const at = boundaries[k];
    const stop = backbone.stops.find((s) => Math.abs(s.km - at) < 1e-3);
    if (stop) {
      const here = builds.filter((b) => b.enterKm <= at + EPS && b.exitKm >= at - EPS);
      if (here.length > 0) {
        const startSec = clock;
        clock += stop.durationSec;
        legs.push({ lo: at, hi: at, present: here.map((b) => b.p.id), paceSec: null, startSec, endSec: clock, name: stop.name });
      }
    }
    if (k >= boundaries.length - 1) break;
    const lo = at;
    const hi = boundaries[k + 1];
    if (hi - lo < EPS) continue;
    const present = builds.filter((b) => covers(b, lo, hi));
    if (present.length === 0) continue;
    const paceSec = Math.max(...present.map((b) => b.ownPaceSec));
    const startSec = clock;
    clock += (hi - lo) * paceSec;
    legs.push({ lo, hi, present: present.map((b) => b.p.id), paceSec, startSec, endSec: clock });
  }
  return legs;
}

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

/**
 * Flock-clock seconds when the flock first ARRIVES at `km` (before any stop
 * there) — the "passes through" time for a waypoint. Unlike tAtLegs, a rest leg
 * at km returns the arrival, not the post-stop departure. Returns null if no run
 * leg reaches km (nobody runs that far).
 */
function arrivalAtKm(legs: Leg[], km: number): number | null {
  for (const lg of legs) {
    if (lg.paceSec == null) continue; // rests don't define arrival; the run leg reaching km does
    // km must actually fall WITHIN this run leg — otherwise (a leading gap where
    // nobody covers km, or km past the last leg) there's no arrival to report.
    if (km >= lg.lo - EPS && km <= lg.hi + EPS) return lg.startSec + (km - lg.lo) * lg.paceSec;
  }
  return null;
}

// --- best-response window optimisation --------------------------------------

interface OptItem {
  id: string;
  budget: number | null; // null = unconstrained (takes the whole route)
  home: LatLng;
}
interface Window {
  enterKm: number;
  exitKm: number;
}

function optimizeWindows(items: OptItem[], backbone: Backbone): Map<string, Window> {
  const total = backbone.totalKm;
  const NSEG = Math.max(16, Math.min(100, Math.round(total / 0.3)));
  const segLen = total / NSEG;
  const pos: number[] = [];
  for (let k = 0; k <= NSEG; k++) pos.push(k * segLen);
  const pts = pos.map((p) => pointAtKm(backbone, p));
  // appr[i][k] = crow approach/egress estimate from home i to boundary point k.
  const appr = items.map((it) => pts.map((pt) => crowKm(it.home, pt) * ROAD_FACTOR));
  const idxOf = (km: number) => Math.max(0, Math.min(NSEG, Math.round(km / segLen)));

  const windows = new Map<string, Window>();
  const presence = new Array(NSEG).fill(0);
  const coversSeg = (w: Window, k: number) => w.enterKm <= pos[k] + EPS && w.exitKm >= pos[k + 1] - EPS;
  const addWin = (w: Window) => {
    for (let k = 0; k < NSEG; k++) if (coversSeg(w, k)) presence[k]++;
  };
  const removeWin = (w: Window) => {
    for (let k = 0; k < NSEG; k++) if (coversSeg(w, k)) presence[k]--;
  };
  const furthestExitIdx = (i: number, ei: number, budget: number | null): number => {
    if (budget == null) return NSEG;
    let best = ei;
    for (let xi = ei; xi <= NSEG; xi++) {
      const cost = appr[i][ei] + (pos[xi] - pos[ei]) + appr[i][xi];
      if (cost <= budget + EPS) best = xi;
    }
    return best;
  };

  // Seed: unconstrained → whole route; constrained → furthest from km 0.
  items.forEach((it, i) => {
    const w: Window =
      it.budget == null
        ? { enterKm: 0, exitKm: total }
        : { enterKm: 0, exitKm: pos[furthestExitIdx(i, 0, it.budget)] };
    windows.set(it.id, w);
    addWin(w);
  });

  // Best-response rounds (constrained runners only; unconstrained stay whole).
  const order = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.budget != null)
    .sort((a, b) => a.it.budget! - b.it.budget!);

  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (const { it, i } of order) {
      const cur = windows.get(it.id)!;
      removeWin(cur);
      const prefix = new Array(NSEG + 1).fill(0);
      for (let k = 0; k < NSEG; k++) prefix[k + 1] = prefix[k] + presence[k] * segLen;

      let best = cur;
      let bestVal = prefix[idxOf(cur.exitKm)] - prefix[idxOf(cur.enterKm)];
      let bestArc = cur.exitKm - cur.enterKm;

      for (let ei = 0; ei <= NSEG; ei++) {
        if (it.budget != null && appr[i][ei] > it.budget) continue;
        for (let xi = ei; xi <= NSEG; xi++) {
          const cost = appr[i][ei] + (pos[xi] - pos[ei]) + appr[i][xi];
          if (it.budget != null && cost > it.budget + EPS) continue;
          const val = prefix[xi] - prefix[ei];
          const arc = pos[xi] - pos[ei];
          // Primary: maximise together-time. Tiebreak: maximise arc — so a runner
          // with no company still runs their distance (and runners with company
          // prefer a longer shared stretch) rather than collapsing to zero.
          if (val > bestVal + EPS || (Math.abs(val - bestVal) <= EPS && arc > bestArc + EPS)) {
            best = { enterKm: pos[ei], exitKm: pos[xi] };
            bestVal = val;
            bestArc = arc;
          }
        }
      }
      if (best.enterKm !== cur.enterKm || best.exitKm !== cur.exitKm) moved = true;
      windows.set(it.id, best);
      addWin(best);
    }
    if (!moved) break;
  }

  return windows;
}

// --- latest-finish trimming (monotone, tightest-first) ----------------------

/** Flock-clock anchor: nobody leaves home before their earliest-start. */
function anchorT0(builds: RunnerBuild[], legs: Leg[]): number {
  if (builds.length === 0) return 0;
  return Math.max(
    ...builds.map((b) => b.earliestSec + b.approachKm * b.ownPaceSec - tAtLegs(legs, b.enterKm)),
  );
}

/**
 * Trim exits with REAL egress so hard constraints hold: distance ≤ maxDistance
 * and arrival ≤ latest-finish. Crow estimates under-read road distance for
 * poorly-connected homes, so we correct against actual ORS egress (a few extra
 * calls only for runners who overshoot). Iterates to convergence; a runner whose
 * approach+egress alone busts their cap ends near zero arc and is then handed a
 * solo loop by the caller.
 */
async function enforceConstraints(builds: RunnerBuild[], backbone: Backbone, T0abs: number): Promise<void> {
  for (let pass = 0; pass < 6; pass++) {
    const legs = computeLegs(builds, backbone);
    let changed = false;
    for (const b of builds) {
      const arc = b.exitKm - b.enterKm;
      if (arc < 0.01) continue;
      const dist = b.approachKm + arc + b.egressKm;
      const latest = b.p.latestFinishTime ? timeToSec(b.p.latestFinishTime) : Infinity;
      const arrival = T0abs + tAtLegs(legs, b.exitKm) + b.egressKm * b.ownPaceSec;
      let cut = 0;
      if (b.p.maxDistance != null && dist > b.p.maxDistance + 0.4) cut = Math.max(cut, dist - b.p.maxDistance);
      if (arrival > latest + 60) cut = Math.max(cut, (arrival - latest) / b.ownPaceSec);
      if (cut <= 0.05) continue;
      b.exitKm = Math.max(b.enterKm, b.exitKm - cut);
      try {
        const eg = await legRoute(pointAtKm(backbone, b.exitKm), b.home);
        b.egressKm = eg.distanceKm;
        b.egressGeom = geomToLatLng(eg.geometry);
      } catch {
        /* keep prior egress */
      }
      changed = true;
    }
    if (!changed) break;
  }
}

/** A standalone solo loop for a runner too far to join the flock route. */
async function soloLoop(b: RunnerBuild): Promise<ComputedRoute | null> {
  let target = targetDistanceKm(b.p) ?? DEFAULT_LOOP_DISTANCE_KM;
  // Keep the solo run inside any latest-finish window too.
  if (b.p.latestFinishTime) {
    const budgetMin = (timeToSec(b.p.latestFinishTime) - b.earliestSec) / 60;
    const maxByTime = (budgetMin * 60 * 0.95) / b.ownPaceSec;
    if (maxByTime > 0.5) target = Math.min(target, maxByTime);
  }
  let ors: OrsRoute;
  try {
    ors = await getRoundTrip(b.home, Math.max(1, target));
  } catch {
    return null;
  }
  const dist = ors.distanceKm;
  const depart = b.earliestSec;
  const arrival = depart + dist * b.ownPaceSec;
  return {
    participantId: b.p.id,
    waypoints: [b.home, b.home],
    geometry: ors.geometry,
    distanceKm: round2(dist),
    estimatedDurationMinutes: Math.round((dist * b.ownPaceSec) / 60),
    departureTime: secToTime(depart),
    arrivalTime: secToTime(arrival),
    schedule: [
      {
        type: "run",
        startTime: secToTime(depart),
        endTime: secToTime(arrival),
        startLocation: b.home,
        endLocation: b.home,
        paceSecPerKm: b.ownPaceSec,
        companionIds: [],
        distanceKm: round2(dist),
      },
    ],
  };
}

/**
 * Give a runner a solo tail beyond the backbone so they reach their distance
 * target. The flock peels off at this runner's exit (the backbone end); they
 * keep going on a loop from that point, then egress home as before. The loop is
 * sized to the exact shortfall and clamped by any latest-finish budget. Mutates
 * the build's `extensionKm` / `extensionGeom`; one extra ORS call.
 */
async function applyExtension(b: RunnerBuild, backbone: Backbone, T0abs: number): Promise<void> {
  const target = targetDistanceKm(b.p);
  if (target == null) return;
  const built = b.approachKm + (b.exitKm - b.enterKm) + b.egressKm;
  let surplus = target - built;
  if (surplus < MIN_EXTENSION_KM) return;

  // Respect latest-finish: the tail + egress must still get home in time.
  if (b.p.latestFinishTime) {
    const exitAbs = T0abs + b.exitClockSec;
    const availSec = timeToSec(b.p.latestFinishTime) - exitAbs - b.egressKm * b.ownPaceSec;
    surplus = Math.min(surplus, availSec / b.ownPaceSec);
  }
  if (surplus < MIN_EXTENSION_KM) {
    log.info("extension skipped (no time budget)", { participantId: b.p.id.slice(0, 4), target });
    return;
  }

  let ors: OrsRoute;
  try {
    ors = await getRoundTrip(pointAtKm(backbone, b.exitKm), surplus);
  } catch {
    log.warn("extension ORS failed — runner stays short", { participantId: b.p.id.slice(0, 4) });
    return;
  }

  // getRoundTrip returns ~surplus km but can overshoot. The tail is a hard add-on
  // (enforceConstraints already ran on the backbone arc, not this), so re-check the
  // ACTUAL loop against both hard caps and drop it rather than bust them. Same
  // tolerances as enforceConstraints (+0.4 km, +60 s).
  const totalKm = built + ors.distanceKm;
  const exitAbs = T0abs + b.exitClockSec;
  const arrival = exitAbs + (ors.distanceKm + b.egressKm) * b.ownPaceSec;
  const bustsDistance = b.p.maxDistance != null && totalKm > b.p.maxDistance + 0.4;
  const bustsTime = b.p.latestFinishTime != null && arrival > timeToSec(b.p.latestFinishTime) + 60;
  if (bustsDistance || bustsTime) {
    log.info("extension rejected (ORS overshoot would bust a cap)", {
      participantId: b.p.id.slice(0, 4),
      reqKm: round2(surplus),
      gotKm: round2(ors.distanceKm),
      bustsDistance,
      bustsTime,
    });
    return;
  }

  b.extensionKm = ors.distanceKm;
  b.extensionGeom = geomToLatLng(ors.geometry);
  log.info("solo extension", {
    participantId: b.p.id.slice(0, 4),
    target,
    backboneKm: round2(backbone.totalKm),
    builtKm: round2(built),
    surplusKm: round2(surplus),
    extKm: round2(ors.distanceKm),
    totalKm: round2(totalKm),
  });
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

  const rendezvous = waypoints[0]?.location ?? centroid(runners.map((p) => p.startLocation));

  // Backbone length (auto only): the "never solo" reach (second-longest arc),
  // using crow approach estimates — no ORS needed for sizing.
  const arcEstimate = (p: Participant): number => {
    const t = targetDistanceKm(p);
    if (t == null) return Infinity;
    return Math.max(0, t - 2 * crowKm(p.startLocation, rendezvous) * ROAD_FACTOR);
  };
  const estsById = runners
    .map((p) => ({ id: p.id, est: arcEstimate(p) }))
    .sort((a, b) => b.est - a.est);
  const ests = estsById.map((e) => e.est);
  const finite = ests.filter((e) => Number.isFinite(e));
  let targetKm: number;
  if (ests.length >= 2 && Number.isFinite(ests[1])) targetKm = ests[1];
  else if (finite.length) targetKm = Math.max(...finite);
  else targetKm = DEFAULT_BACKBONE_KM;
  targetKm = Math.max(1, targetKm);

  const backbone = await buildBackbone({ waypoints, starts: runners.map((p) => p.startLocation), targetKm });

  // Solo-extension candidate: the single runner whose reach clears the backbone.
  // The backbone stops at the second-longest reach, so for an auto backbone only
  // the keenest qualifies; for an explicit (longer) waypoint skeleton, possibly
  // none. Their surplus distance becomes a solo tail past the flock's peel-off.
  const top = estsById[0];
  const extendCandidateId =
    top && Number.isFinite(top.est) && top.est > backbone.totalKm + MIN_EXTENSION_KM ? top.id : null;

  // Best-response: choose each runner's [enter, exit] to maximise together-time.
  const windows = optimizeWindows(
    runners.map((p) => ({ id: p.id, budget: targetDistanceKm(p), home: p.startLocation })),
    backbone,
  );
  log.info("windows", {
    flockId: session.id,
    backboneKm: round2(backbone.totalKm),
    windows: runners.map((p) => {
      const w = windows.get(p.id)!;
      return { id: p.id.slice(0, 4), e: round2(w.enterKm), x: round2(w.exitKm) };
    }),
  });

  // ORS the chosen approach + egress endpoints (parallel).
  const warnings: CalcWarning[] = [];
  const settled = await Promise.allSettled(
    runners.map(async (p) => {
      const w = windows.get(p.id)!;
      const [approach, egress] = await Promise.all([
        legRoute(p.startLocation, pointAtKm(backbone, w.enterKm)),
        legRoute(pointAtKm(backbone, w.exitKm), p.startLocation),
      ]);
      return { p, w, approach, egress };
    }),
  );

  const builds: RunnerBuild[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const { p, w, approach, egress } = r.value;
      builds.push({
        p,
        ownPaceSec: paceOf(p),
        earliestSec: earliestOf(p),
        home: p.startLocation,
        enterKm: w.enterKm,
        exitKm: w.exitKm,
        approachKm: approach.distanceKm,
        approachGeom: geomToLatLng(approach.geometry),
        egressKm: egress.distanceKm,
        egressGeom: geomToLatLng(egress.geometry),
        departHomeSec: 0,
        enterClockSec: 0,
        exitClockSec: 0,
        extensionKm: 0,
        extensionGeom: [],
      });
    } else {
      const code = r.reason instanceof RouteError ? r.reason.code : "ors-error";
      log.warn("runner route failed", { participantId: runners[i].id, code });
      warnings.push({
        participantId: runners[i].id,
        message:
          code === "no-route"
            ? "We couldn't find a runnable route from your start — try moving your pin."
            : "Routes are taking longer than usual — trying again shortly.",
      });
    }
  });
  if (builds.length === 0) {
    done({ skipped: true });
    return empty(true);
  }

  // Flock-clock anchor (depends only on entries, stable through exit trimming).
  let legs = computeLegs(builds, backbone);
  let T0abs = anchorT0(builds, legs);

  // Enforce hard constraints (distance cap + latest-finish) with REAL egress.
  await enforceConstraints(builds, backbone, T0abs);

  // Strand anyone who still can't fit their distance cap OR latest-finish on the
  // route (home too far, or the flock reaches them too late to get home in time).
  // They get a solo loop instead of being forced over a hard limit.
  const postLegs = computeLegs(builds, backbone);
  const postT0 = anchorT0(builds, postLegs);
  const stranded = builds.filter((b) => {
    const dist = b.approachKm + (b.exitKm - b.enterKm) + b.egressKm;
    if (b.p.maxDistance != null && dist > b.p.maxDistance + 0.8) return true;
    if (b.p.latestFinishTime) {
      const arrival = postT0 + tAtLegs(postLegs, b.exitKm) + b.egressKm * b.ownPaceSec;
      if (arrival > timeToSec(b.p.latestFinishTime) + 90) return true;
    }
    return false;
  });
  const onBackbone = builds.filter((b) => !stranded.includes(b));

  legs = computeLegs(onBackbone, backbone);
  T0abs = onBackbone.length ? anchorT0(onBackbone, legs) : postT0;
  for (const b of onBackbone) {
    b.enterClockSec = tAtLegs(legs, b.enterKm);
    b.exitClockSec = tAtLegs(legs, b.exitKm);
    b.departHomeSec = T0abs + b.enterClockSec - b.approachKm * b.ownPaceSec;
  }

  // Solo extension: the keenest runner continues past the peel-off to make up
  // the distance the (capped) backbone left short. Pure solo — no TM effect.
  const candidate = extendCandidateId ? onBackbone.find((b) => b.p.id === extendCandidateId) : undefined;
  if (candidate) await applyExtension(candidate, backbone, T0abs);

  const soloRoutes = (await Promise.all(stranded.map((b) => soloLoop(b)))).filter(
    (r): r is ComputedRoute => r != null,
  );
  for (const b of stranded) {
    warnings.push({
      participantId: b.p.id,
      message: "You're too far from the flock's route to join within your distance — here's a solo run near home instead.",
    });
  }

  log.info("flock plan", {
    flockId: session.id,
    onBackbone: onBackbone.length,
    solo: stranded.length,
    extended: onBackbone.filter((b) => b.extensionKm > 0.02).length,
    legs: legs.length,
  });

  const routes: ComputedRoute[] = [
    ...onBackbone.map((b) => buildComputed(b, backbone, legs, T0abs)),
    ...soloRoutes,
  ];

  const sharedSegments: SharedSegment[] = legs
    .filter((lg) => lg.paceSec != null && lg.present.length >= 2)
    .map((lg) => ({
      participantIds: lg.present,
      geometry: toLineString(sliceKm(backbone, lg.lo, lg.hi)),
      overlapMinutes: round2((lg.endSec - lg.startSec) / 60),
      startTime: secToTime(T0abs + lg.startSec),
    }));

  // Together-Minutes (wall + system) + pairwise.
  let togetherWallMin = 0;
  let systemTM = 0;
  const pairMin = new Map<string, number>();
  const pairCount = new Map<string, number>();
  for (const lg of legs) {
    const durMin = (lg.endSec - lg.startSec) / 60;
    const n = lg.present.length;
    if (n < 2) continue;
    togetherWallMin += durMin;
    systemTM += durMin * n * (n - 1);
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) {
        const key = [lg.present[a], lg.present[b]].sort().join("|");
        pairMin.set(key, (pairMin.get(key) ?? 0) + durMin);
        if (lg.paceSec != null) pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
  }
  const pairwiseSummary: PairSummary[] = [...pairMin.entries()].map(([key, min]) => {
    const [a, b] = key.split("|");
    return { participantA: a, participantB: b, togetherMinutes: round2(min), togetherStretchCount: pairCount.get(key) ?? 0 };
  });

  for (const b of onBackbone) warnings.push(...buildWarnings(b));

  // Per-waypoint pass-through times: one flock clock → one time each. Omit any
  // waypoint the flock never reaches (km beyond everyone's furthest exit).
  const maxExit = Math.max(0, ...onBackbone.map((b) => b.exitKm));
  const waypointEtas: Record<string, string> = {};
  for (const w of waypoints) {
    const km = nearestKm(backbone, w.location);
    if (km > maxExit + 0.05) continue;
    const sec = arrivalAtKm(legs, km);
    if (sec != null) waypointEtas[w.id] = secToTime(T0abs + sec);
  }

  done({
    routes: routes.length,
    sharedSegments: sharedSegments.length,
    togetherWallMin: round2(togetherWallMin),
    systemTogetherMinutes: round2(systemTM),
    waypointEtas: Object.keys(waypointEtas).length,
  });

  return {
    routes,
    sharedSegments,
    flockRoute: toLineString(backbone.coords),
    waypointEtas: Object.keys(waypointEtas).length ? waypointEtas : null,
    summary: { totalTogetherMinutes: round2(togetherWallMin), pairwiseSummary },
    warnings,
    skipped: false,
  };
}

// --- per-runner assembly ----------------------------------------------------

function buildComputed(b: RunnerBuild, backbone: Backbone, legs: Leg[], T0abs: number): ComputedRoute {
  const backboneSlice = sliceKm(backbone, b.enterKm, b.exitKm);
  const exitPoint = pointAtKm(backbone, b.exitKm);
  const fullGeom = [...b.approachGeom, ...backboneSlice, ...b.extensionGeom, ...b.egressGeom];
  const enterAbs = T0abs + b.enterClockSec;
  const exitAbs = T0abs + b.exitClockSec;
  const extEndAbs = exitAbs + b.extensionKm * b.ownPaceSec; // == exitAbs when no extension
  const arrival = extEndAbs + b.egressKm * b.ownPaceSec;
  const distanceKm = b.approachKm + (b.exitKm - b.enterKm) + b.extensionKm + b.egressKm;

  const schedule: ScheduleSegment[] = [];

  if (b.approachKm > 0.02) {
    schedule.push({
      type: "run",
      startTime: secToTime(b.departHomeSec),
      endTime: secToTime(enterAbs),
      startLocation: b.home,
      endLocation: pointAtKm(backbone, b.enterKm),
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.approachKm),
    });
  }

  for (const lg of legs) {
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

  if (b.extensionKm > 0.02) {
    // Solo tail: the flock has peeled off; this runner loops on past the exit.
    schedule.push({
      type: "run",
      startTime: secToTime(exitAbs),
      endTime: secToTime(extEndAbs),
      startLocation: exitPoint,
      endLocation: exitPoint,
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.extensionKm),
    });
  }

  if (b.egressKm > 0.02) {
    schedule.push({
      type: "run",
      startTime: secToTime(extEndAbs),
      endTime: secToTime(arrival),
      startLocation: exitPoint,
      endLocation: b.home,
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.egressKm),
    });
  }

  return {
    participantId: b.p.id,
    waypoints: [b.home, pointAtKm(backbone, b.enterKm), exitPoint, b.home],
    geometry: toLineString(fullGeom),
    distanceKm: round2(distanceKm),
    estimatedDurationMinutes: Math.round((arrival - b.departHomeSec) / 60),
    departureTime: secToTime(b.departHomeSec),
    arrivalTime: secToTime(arrival),
    schedule,
  };
}

function buildWarnings(b: RunnerBuild): CalcWarning[] {
  const out: CalcWarning[] = [];
  const distanceKm = b.approachKm + (b.exitKm - b.enterKm) + b.extensionKm + b.egressKm;
  const target = targetDistanceKm(b.p);
  const arcKm = b.exitKm - b.enterKm;

  if (b.extensionKm > 0.02) {
    out.push({
      participantId: b.p.id,
      message: `You go further than the rest, so you'll run the last ${b.extensionKm.toFixed(1)}km solo — the flock peels off where it reaches its turnaround.`,
    });
  }

  if (b.p.earliestStartTime && b.p.latestFinishTime) {
    const availableMin = (timeToSec(b.p.latestFinishTime) - timeToSec(b.p.earliestStartTime)) / 60;
    const requiredMin = (distanceKm * b.ownPaceSec) / 60;
    if (availableMin > 0 && requiredMin > availableMin + 1) {
      out.push({
        participantId: b.p.id,
        message: `At your pace, ${distanceKm.toFixed(1)}km takes about ${Math.round(requiredMin)} min — but you've only got ${Math.round(availableMin)} min. Adjust one or the other.`,
      });
    }
  }
  if (arcKm < 0.3) {
    out.push({ participantId: b.p.id, message: "You're a bit far from the flock's path to join it within your limits." });
  } else if (b.approachKm + b.egressKm > arcKm) {
    out.push({ participantId: b.p.id, message: "More of your run is getting to and from the flock than with it — you might be a little far from the route." });
  }
  if (target != null && distanceKm + 1.5 < target) {
    out.push({ participantId: b.p.id, message: `Your route's about ${distanceKm.toFixed(1)}km, a bit under your ${target}km — add a waypoint to stretch it.` });
  }
  return out;
}

function empty(skipped: boolean): CalcResult {
  return { routes: [], sharedSegments: [], flockRoute: null, waypointEtas: null, summary: { totalTogetherMinutes: 0, pairwiseSummary: [] }, warnings: [], skipped };
}
