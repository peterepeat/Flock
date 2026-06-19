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
  DISTANCE_MAX_KM,
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
// Solo fill loops are requested a touch under their available room because ORS
// round-trips overshoot the asked length and a loop can't be trimmed (it must
// return to its start to egress) — so we leave headroom rather than bust a cap.
const FILL_SAFETY = 0.85;
// Opportunistic overlap: two runners on their APPROACH/EGRESS feeder legs count
// as together when within this distance at the same instant, for at least this
// long (filters incidental crossings). The backbone clock already handles the
// shared route; this catches neighbours who run to/from the flock together.
const OPP_OVERLAP_M = 60;
const OPP_MIN_SEC = 120;

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
  home: LatLng; // where the approach STARTS (always the runner's start)
  finishPt: LatLng; // where the egress ENDS — the chosen finish, else the start
  enterKm: number;
  exitKm: number;
  approachKm: number;
  approachGeom: LatLng[];
  egressKm: number;
  egressGeom: LatLng[];
  departHomeSec: number;
  enterClockSec: number; // flock-clock secs at enter
  exitClockSec: number; // flock-clock secs at exit (incl. stops passed)
  // Solo distance the runner adds on their own to reach their target, placed in
  // their time slack so it never costs flock time: a cool-down loop after the
  // peel-off and/or a warm-up loop before the join (0 = none).
  cooldownKm: number;
  cooldownGeom: LatLng[]; // a loop from the exit point back to it
  warmupKm: number;
  warmupGeom: LatLng[]; // a loop from home back to it, run before setting off
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
      // Only runners CONTINUING past the stop sit through its dwell. A runner whose
      // exit is AT the stop peels off the moment the flock arrives (no dwell), so
      // their distance/time isn't charged for a stop they don't take.
      const here = builds.filter((b) => b.enterKm <= at + EPS && b.exitKm > at + EPS);
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

/**
 * Flock-clock seconds at which a runner LEAVES the flock if they peel off at `km`.
 * Same as tAtLegs everywhere except AT a stop, where it's the pre-dwell arrival
 * (the runner exits the instant the flock arrives — they don't sit through a stop
 * they're peeling off at). Falls back to tAtLegs if no run leg reaches km.
 */
function exitClockOf(legs: Leg[], km: number): number {
  return arrivalAtKm(legs, km) ?? tAtLegs(legs, km);
}

// --- opportunistic overlap on feeder (approach/egress) legs -----------------

interface TimedPt {
  ll: LatLng;
  sec: number; // absolute seconds the runner is at this vertex
}
interface OppRun {
  a: string;
  b: string;
  startSec: number;
  endSec: number;
  geom: LatLng[];
}

/** A feeder polyline timestamped by constant-pace travel from `startSec`. */
function feederPoints(geom: LatLng[], startSec: number, paceSec: number): TimedPt[] {
  const out: TimedPt[] = [];
  let cum = 0;
  for (let i = 0; i < geom.length; i++) {
    if (i > 0) cum += distanceMeters(geom[i - 1], geom[i]) / 1000;
    out.push({ ll: geom[i], sec: startSec + cum * paceSec });
  }
  return out;
}

/** Where a timed feeder is at absolute time `t` (null if outside its window). */
function posAtTime(pts: TimedPt[], t: number): LatLng | null {
  if (pts.length === 0 || t < pts[0].sec - EPS || t > pts[pts.length - 1].sec + EPS) return null;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].sec) {
      const a = pts[i - 1];
      const c = pts[i];
      const f = c.sec > a.sec ? (t - a.sec) / (c.sec - a.sec) : 0;
      return { lat: a.ll.lat + (c.ll.lat - a.ll.lat) * f, lng: a.ll.lng + (c.ll.lng - a.ll.lng) * f };
    }
  }
  return pts[pts.length - 1].ll;
}

/** Contiguous spans where feeder `fa` is within OPP_OVERLAP_M of `fb` at the same instant. */
function feederRuns(fa: TimedPt[], fb: TimedPt[]): { startSec: number; endSec: number; geom: LatLng[] }[] {
  // Sample at the UNION of both feeders' vertex times (deduped, ascending) so the
  // result is symmetric regardless of which side has denser ORS geometry — a
  // closest-approach at either runner's vertex is caught.
  const times = [...fa, ...fb].map((p) => p.sec).sort((x, y) => x - y);
  const runs: { startSec: number; endSec: number; geom: LatLng[] }[] = [];
  let cur: TimedPt[] = [];
  const flush = () => {
    if (cur.length >= 2 && cur[cur.length - 1].sec - cur[0].sec >= OPP_MIN_SEC) {
      runs.push({ startSec: cur[0].sec, endSec: cur[cur.length - 1].sec, geom: cur.map((p) => p.ll) });
    }
    cur = [];
  };
  let lastT = NaN;
  for (const t of times) {
    if (t === lastT) continue;
    lastT = t;
    const pa = posAtTime(fa, t);
    const pb = posAtTime(fb, t);
    const d = pa && pb ? distanceMeters(pa, pb) : Infinity;
    if (Number.isFinite(d) && d <= OPP_OVERLAP_M) cur.push({ ll: pa as LatLng, sec: t });
    else flush();
  }
  flush();
  return runs;
}

/**
 * Find together-time on feeder legs: runners whose approach (or way home) paths
 * coincide in space AND time. Pure bonus on top of the backbone legs — feeders
 * are solo by construction, so this never double-counts shared-route time.
 */
function opportunisticOverlap(builds: RunnerBuild[], T0abs: number): OppRun[] {
  const feeders = builds.map((b) => {
    const list: TimedPt[][] = [];
    if (b.approachKm > 0.2 && b.approachGeom.length >= 2) {
      // The approach starts after any warm-up loop, not at departure.
      const approachStart = b.departHomeSec + b.warmupKm * b.ownPaceSec;
      list.push(feederPoints(b.approachGeom, approachStart, b.ownPaceSec));
    }
    if (b.egressKm > 0.2 && b.egressGeom.length >= 2) {
      const egressStart = T0abs + b.exitClockSec + b.cooldownKm * b.ownPaceSec;
      list.push(feederPoints(b.egressGeom, egressStart, b.ownPaceSec));
    }
    return { id: b.p.id, list };
  });

  const out: OppRun[] = [];
  for (let i = 0; i < feeders.length; i++) {
    for (let j = i + 1; j < feeders.length; j++) {
      for (const fa of feeders[i].list) {
        for (const fb of feeders[j].list) {
          for (const run of feederRuns(fa, fb)) {
            out.push({ a: feeders[i].id, b: feeders[j].id, ...run });
          }
        }
      }
    }
  }
  return out;
}

// --- best-response window optimisation --------------------------------------

interface OptItem {
  id: string;
  budget: number | null; // null = unconstrained (takes the whole route)
  home: LatLng; // approach origin (start)
  finish: LatLng; // egress destination (chosen finish, else start)
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
  // Crow feeder estimates to each boundary point: approach is start→point,
  // egress is finish→point. They differ only when a runner picked a separate
  // finish; otherwise finish === start and the two tables coincide.
  const apprStart = items.map((it) => pts.map((pt) => crowKm(it.home, pt) * ROAD_FACTOR));
  const apprFinish = items.map((it) => pts.map((pt) => crowKm(it.finish, pt) * ROAD_FACTOR));
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
      const cost = apprStart[i][ei] + (pos[xi] - pos[ei]) + apprFinish[i][xi];
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
        if (it.budget != null && apprStart[i][ei] > it.budget) continue;
        for (let xi = ei; xi <= NSEG; xi++) {
          const cost = apprStart[i][ei] + (pos[xi] - pos[ei]) + apprFinish[i][xi];
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
      const arrival = T0abs + exitClockOf(legs, b.exitKm) + b.egressKm * b.ownPaceSec;

      // Distance cap: stops save no distance, so trim the arc proportionally.
      const distExit =
        b.p.maxDistance != null && dist > b.p.maxDistance + 0.4
          ? Math.max(b.enterKm, b.exitKm - (dist - b.p.maxDistance))
          : b.exitKm;

      // Latest-finish: the proportional trim, BUT prefer landing at the highest
      // stop the runner can still reach and get home from in time — exiting at a
      // stop sheds its dwell (and every dwell after it), buying back arc the
      // proportional cut would have thrown away. Stop egress is a crow estimate
      // here; the real ORS egress below re-checks it next pass.
      let timeExit = b.exitKm;
      if (arrival > latest + 60) {
        timeExit = Math.max(b.enterKm, b.exitKm - (arrival - latest) / b.ownPaceSec);
        for (const s of backbone.stops) {
          if (s.km <= b.enterKm + EPS || s.km >= b.exitKm - EPS || s.km <= timeExit) continue;
          const egEst = crowKm(pointAtKm(backbone, s.km), b.finishPt) * ROAD_FACTOR;
          const arrAtStop = T0abs + exitClockOf(legs, s.km) + egEst * b.ownPaceSec;
          if (arrAtStop <= latest + 60) timeExit = s.km; // keep the highest feasible
        }
      }

      const newExit = Math.max(b.enterKm, Math.min(distExit, timeExit));
      if (b.exitKm - newExit <= 0.05) continue;
      b.exitKm = newExit;
      try {
        const eg = await legRoute(pointAtKm(backbone, b.exitKm), b.finishPt);
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

/** Fetch a round-trip loop of ~`km` from `at`; null on ORS failure. */
async function tryLoop(at: LatLng, km: number): Promise<{ km: number; geom: LatLng[] } | null> {
  try {
    const ors = await getRoundTrip(at, Math.max(1, km));
    return { km: ors.distanceKm, geom: geomToLatLng(ors.geometry) };
  } catch {
    return null;
  }
}

/**
 * A solo loop that lands WITHIN `maxKm` (the room it must fit). ORS round-trips
 * overshoot their requested length unpredictably and a loop can't be trimmed (it
 * must return to its start), so we ask a touch under, and if the result still
 * overshoots the ceiling we retry once scaled by the observed overshoot. Null if
 * ORS fails or it still won't fit.
 */
async function fitLoop(at: LatLng, maxKm: number): Promise<{ km: number; geom: LatLng[] } | null> {
  if (maxKm < MIN_EXTENSION_KM) return null;
  const loop = await tryLoop(at, maxKm * FILL_SAFETY);
  if (!loop || loop.km <= maxKm) return loop;
  const scaled = maxKm * FILL_SAFETY * (maxKm / loop.km);
  if (scaled < 1) return null;
  const retry = await tryLoop(at, scaled);
  return retry && retry.km <= maxKm ? retry : null;
}

/**
 * Fill a runner's distance deficit with SOLO loops placed in their time slack, so
 * the extra distance never costs flock time. The deficit is whatever the flock
 * route + feeders left short of their target; it's absorbed by:
 *   • a COOL-DOWN loop from the exit point, before egressing home (bounded by
 *     latest-finish), and/or
 *   • a WARM-UP loop from home, before the join (bounded by earliest-start —
 *     shifts departure earlier, never touches the rendezvous or arrival).
 * Both are re-checked against the actual ORS length (round-trips overshoot) and
 * dropped rather than bust a cap. Most runners self-skip (deficit < MIN_EXTENSION_KM)
 * with zero ORS calls. Mutates the cooldown/warmup fields (and departHomeSec).
 */
async function applySoloFill(b: RunnerBuild, backbone: Backbone, T0abs: number): Promise<void> {
  const target = targetDistanceKm(b.p);
  if (target == null) return;
  const built = b.approachKm + (b.exitKm - b.enterKm) + b.egressKm;
  // The cap is the most any loop may add (same +0.4 tolerance as enforce).
  const capCeil = b.p.maxDistance != null ? b.p.maxDistance + 0.4 : Infinity;
  let deficit = Math.min(target, capCeil) - built;
  if (deficit < MIN_EXTENSION_KM) return;

  // Each "room" is the MAX km that side can absorb (cap + time tolerances baked in).
  // We request a touch under it (round-trips overshoot, and a loop can't be trimmed
  // without breaking its return to the start), and accept only a loop that lands
  // within the room.
  const exitAbs = T0abs + b.exitClockSec;
  const latest = b.p.latestFinishTime != null ? timeToSec(b.p.latestFinishTime) + 60 : Infinity;

  // Cool-down loop from the exit, before egress: bounded by latest-finish + cap.
  const cooldownRoom = Math.min(
    deficit,
    capCeil - built,
    (latest - exitAbs - b.egressKm * b.ownPaceSec) / b.ownPaceSec,
  );
  if (cooldownRoom >= MIN_EXTENSION_KM) {
    const loop = await fitLoop(pointAtKm(backbone, b.exitKm), cooldownRoom);
    if (loop) {
      b.cooldownKm = loop.km;
      b.cooldownGeom = loop.geom;
      deficit -= loop.km;
    }
  }

  // Warm-up loop from home, before setting off: uses the slack between earliest-start
  // and when they'd otherwise leave (shifts departure earlier only) + cap.
  const earliest = b.earliestSec - 60;
  const warmupRoom = Math.min(
    deficit,
    capCeil - built - b.cooldownKm,
    (b.departHomeSec - earliest) / b.ownPaceSec,
  );
  if (warmupRoom >= MIN_EXTENSION_KM) {
    const loop = await fitLoop(b.home, warmupRoom);
    if (loop) {
      b.warmupKm = loop.km;
      b.warmupGeom = loop.geom;
      b.departHomeSec -= loop.km * b.ownPaceSec;
    }
  }

  if (b.cooldownKm > 0.02 || b.warmupKm > 0.02) {
    log.info("solo fill", {
      participantId: b.p.id.slice(0, 4),
      target,
      builtKm: round2(built),
      warmupKm: round2(b.warmupKm),
      cooldownKm: round2(b.cooldownKm),
      totalKm: round2(built + b.warmupKm + b.cooldownKm),
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

  const rendezvous = waypoints[0]?.location ?? centroid(runners.map((p) => p.startLocation));

  // A runner egresses to their chosen finish if they set one, else back to start.
  const finishOf = (p: Participant): LatLng => p.finishLocation ?? p.startLocation;

  // Shared-route length L* — the "never solo on the spine" reach: the SECOND-
  // longest runner's on-backbone reach, so the two longest can run the whole
  // shared route together and only the single longest ever solos a tail. This
  // governs BOTH modes — an auto loop is sized to it, and a waypoint corridor is
  // GROWN to it (buildBackbone) when the waypoints alone fall short.
  //
  // reach = distance target − road-factored feeder (approach + egress). The
  // feeder is corridor-aware: approach to the first waypoint (km 0), egress from
  // the LAST waypoint (the corridor's far end); with no corridor both anchor to
  // the rendezvous (so auto mode is unchanged — finish===start is the old
  // symmetric 2× round-trip).
  const egressAnchor =
    waypoints.length >= 2 ? waypoints[waypoints.length - 1].location : rendezvous;
  const arcEstimate = (p: Participant): number => {
    const t = targetDistanceKm(p);
    if (t == null) return Infinity;
    const feeder =
      (crowKm(p.startLocation, rendezvous) + crowKm(finishOf(p), egressAnchor)) * ROAD_FACTOR;
    return Math.max(0, t - feeder);
  };
  const estsById = runners
    .map((p) => ({ id: p.id, est: arcEstimate(p) }))
    .sort((a, b) => b.est - a.est);
  const ests = estsById.map((e) => e.est); // sorted desc; unconstrained = Infinity first
  const finite = ests.filter((e) => Number.isFinite(e)); // still sorted desc
  // The second-most-capable runner's reach (so the top two cover the whole spine).
  // ests[1] is that runner — finite when ≤1 runner is unconstrained. With ≥2
  // unconstrained it's Infinity, so cap at the longest finite reach; with none
  // finite, the default. (This is the prior rule, just hardened so the result is
  // never Infinity — a latent crash once waypoint mode consumes targetKm — and
  // clamped to the distance ceiling.)
  let targetKm: number;
  if (Number.isFinite(ests[1])) targetKm = ests[1];
  else if (finite.length) targetKm = finite[0];
  else targetKm = DEFAULT_BACKBONE_KM;
  targetKm = Math.max(1, Math.min(targetKm, DISTANCE_MAX_KM));

  const backbone = await buildBackbone({ waypoints, starts: runners.map((p) => p.startLocation), targetKm });

  // Best-response: choose each runner's [enter, exit] to maximise together-time.
  const windows = optimizeWindows(
    runners.map((p) => ({
      id: p.id,
      budget: targetDistanceKm(p),
      home: p.startLocation,
      finish: finishOf(p),
    })),
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
        legRoute(pointAtKm(backbone, w.exitKm), finishOf(p)),
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
        finishPt: finishOf(p),
        enterKm: w.enterKm,
        exitKm: w.exitKm,
        approachKm: approach.distanceKm,
        approachGeom: geomToLatLng(approach.geometry),
        egressKm: egress.distanceKm,
        egressGeom: geomToLatLng(egress.geometry),
        departHomeSec: 0,
        enterClockSec: 0,
        exitClockSec: 0,
        cooldownKm: 0,
        cooldownGeom: [],
        warmupKm: 0,
        warmupGeom: [],
      });
    } else {
      const code = r.reason instanceof RouteError ? r.reason.code : "ors-error";
      log.warn("runner route failed", { participantId: runners[i].id, code });
      const message =
        code === "no-route"
          ? "We couldn't find a runnable route from your start — try moving your pin."
          : code === "quota-exhausted"
            ? "Daily routing limit reached — routes will work again once it resets."
            : "Routes are taking longer than usual — trying again shortly.";
      warnings.push({ participantId: runners[i].id, message });
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
      const arrival = postT0 + exitClockOf(postLegs, b.exitKm) + b.egressKm * b.ownPaceSec;
      if (arrival > timeToSec(b.p.latestFinishTime) + 90) return true;
    }
    return false;
  });
  const onBackbone = builds.filter((b) => !stranded.includes(b));

  legs = computeLegs(onBackbone, backbone);
  T0abs = onBackbone.length ? anchorT0(onBackbone, legs) : postT0;
  for (const b of onBackbone) {
    b.enterClockSec = tAtLegs(legs, b.enterKm);
    b.exitClockSec = exitClockOf(legs, b.exitKm);
    b.departHomeSec = T0abs + b.enterClockSec - b.approachKm * b.ownPaceSec;
  }

  // Distance-soaking solo fill: ANY runner short of their target absorbs the
  // deficit in their time slack — a cool-down loop after the peel-off and/or a
  // warm-up loop before the join — never costing flock time. After the spine is
  // grown to the two longest, most runners cover their distance ON the flock route
  // and self-skip here (deficit < MIN_EXTENSION_KM, before any ORS call), so only
  // genuine outliers fetch a loop. Independent per runner → run concurrently.
  await Promise.all(onBackbone.map((b) => applySoloFill(b, backbone, T0abs)));

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
    extended: onBackbone.filter((b) => b.cooldownKm > 0.02 || b.warmupKm > 0.02).length,
    legs: legs.length,
  });

  const routes: ComputedRoute[] = [
    ...onBackbone.map((b) => buildComputed(b, backbone, legs, T0abs)),
    ...soloRoutes,
  ];

  // A leg is a "meet here" point only when someone JOINS the flock here — the
  // present-set gains a member relative to the previous TRAVEL leg (and the first
  // one, where everyone converges at the rendezvous). A pure peel-off leg (the set
  // only shrinks) is still drawn as a together segment but isn't a meeting, so it
  // earns no diamond. We compare against the previous *travel* leg, NOT legs[i-1]:
  // computeLegs interleaves a zero-length STOP leg at each waypoint stop, and a
  // stop leg's present-set already includes anyone joining at that km — so using
  // it as `prev` would mask a real join (notably a rendezvous café at km 0, which
  // would otherwise lose its diamond). Stop legs never reset the tracked set.
  const sharedSegments: SharedSegment[] = [];
  let prevTravelPresent: string[] = [];
  for (const lg of legs) {
    if (lg.paceSec == null) continue; // stop leg — not a segment, doesn't reset join detection
    if (lg.present.length >= 2) {
      const joined = lg.present.some((id) => !prevTravelPresent.includes(id));
      sharedSegments.push({
        participantIds: lg.present,
        geometry: toLineString(sliceKm(backbone, lg.lo, lg.hi)),
        overlapMinutes: round2((lg.endSec - lg.startSec) / 60),
        startTime: secToTime(T0abs + lg.startSec),
        isConvergence: joined,
      });
    }
    prevTravelPresent = lg.present;
  }

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
  // Opportunistic overlap: bonus together-time where feeder legs coincide
  // (neighbours running to/from the flock together). Pairwise by nature, folded
  // into the same tallies and surfaced as extra shared segments on the map.
  const oppRuns = opportunisticOverlap(onBackbone, T0abs);
  for (const run of oppRuns) {
    const durMin = (run.endSec - run.startSec) / 60;
    togetherWallMin += durMin;
    systemTM += durMin * 2; // a pair: n·(n−1) = 2
    const key = [run.a, run.b].sort().join("|");
    pairMin.set(key, (pairMin.get(key) ?? 0) + durMin);
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    sharedSegments.push({
      participantIds: [run.a, run.b],
      geometry: toLineString(run.geom),
      overlapMinutes: round2(durMin),
      startTime: secToTime(run.startSec),
      isConvergence: true, // two neighbours genuinely converge on a feeder leg
    });
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
    opportunistic: oppRuns.length,
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
  const fullGeom = [...b.warmupGeom, ...b.approachGeom, ...backboneSlice, ...b.cooldownGeom, ...b.egressGeom];
  const enterAbs = T0abs + b.enterClockSec;
  const exitAbs = T0abs + b.exitClockSec;
  const extEndAbs = exitAbs + b.cooldownKm * b.ownPaceSec; // == exitAbs when no cool-down
  const arrival = extEndAbs + b.egressKm * b.ownPaceSec;
  const distanceKm = b.warmupKm + b.approachKm + (b.exitKm - b.enterKm) + b.cooldownKm + b.egressKm;
  // departHomeSec already includes the warm-up shift; the approach starts after it.
  const approachStartAbs = b.departHomeSec + b.warmupKm * b.ownPaceSec;

  const schedule: ScheduleSegment[] = [];

  if (b.warmupKm > 0.02) {
    // Warm-up loop from home before setting off to meet the flock.
    schedule.push({
      type: "run",
      startTime: secToTime(b.departHomeSec),
      endTime: secToTime(approachStartAbs),
      startLocation: b.home,
      endLocation: b.home,
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.warmupKm),
    });
  }

  if (b.approachKm > 0.02) {
    schedule.push({
      type: "run",
      startTime: secToTime(approachStartAbs),
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

  if (b.cooldownKm > 0.02) {
    // Solo tail: the flock has peeled off; this runner loops on past the exit.
    schedule.push({
      type: "run",
      startTime: secToTime(exitAbs),
      endTime: secToTime(extEndAbs),
      startLocation: exitPoint,
      endLocation: exitPoint,
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.cooldownKm),
    });
  }

  if (b.egressKm > 0.02) {
    schedule.push({
      type: "run",
      startTime: secToTime(extEndAbs),
      endTime: secToTime(arrival),
      startLocation: exitPoint,
      endLocation: b.finishPt,
      paceSecPerKm: b.ownPaceSec,
      companionIds: [],
      distanceKm: round2(b.egressKm),
    });
  }

  return {
    participantId: b.p.id,
    waypoints: [b.home, pointAtKm(backbone, b.enterKm), exitPoint, b.finishPt],
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
  const distanceKm =
    b.warmupKm + b.approachKm + (b.exitKm - b.enterKm) + b.cooldownKm + b.egressKm;
  const target = targetDistanceKm(b.p);
  const arcKm = b.exitKm - b.enterKm;

  if (b.warmupKm > 0.02) {
    out.push({
      participantId: b.p.id,
      message: `You set off early for a ${b.warmupKm.toFixed(1)}km warm-up loop before meeting the flock, so you reach your distance without cutting the time together short.`,
    });
  }
  if (b.cooldownKm > 0.02) {
    out.push({
      participantId: b.p.id,
      message: `You go further than the rest, so you'll run the last ${b.cooldownKm.toFixed(1)}km solo — the flock peels off where it reaches its turnaround.`,
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
