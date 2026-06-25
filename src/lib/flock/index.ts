// ---------------------------------------------------------------------------
// Flock engine — the boundary between the persisted FlockSession and the pure planner.
// Resolves the shared route, the flock's departure time, and each runner's start/finish
// pins (auto / waypoint / manual) into the engine's arc-space input, runs the planner,
// and projects the plan back onto the app's CalcResult render contract.
//
// This REPLACES the legacy routeEngine.ts. The objective is together-time alone; there is
// no convergence solver, no fairness pass, no solo-fill — those served a problem this
// social-first model doesn't have.
// ---------------------------------------------------------------------------

import { distanceMeters } from "../geo";
import { getRoute } from "../ors";
import type { FlockSession, LatLng, LocationPin } from "../types";
import { timeToSec } from "../units";
import type { Bound, Runner } from "./model";
import { arrivalAt, planRun, resolveAutoStart } from "./plan";
import { projectPlan, type Connectors, type FlockCalcResult, type Unroutable } from "./project";
import { buildSpine, lastNearKm, nearestKm, pointAtKm } from "./route";

const DEFAULT_PACE = 360; // 6:00/km
// Clamp an absurd intended distance (the UI slider tops out at 80 km; this only bites pathological API
// input). NOTE: this bounds DISTANCE, not DURATION — a 200 km route at a slow pace can still exceed 24h
// and secToTime (single-day HH:MM) would wrap. That residual is accepted/untested (UI-unreachable); the
// principled fix, if ever wanted, is a day-aware render, not a tighter km clamp.
const MAX_RUN_KM = 200;

const geomToLatLng = (g: GeoJSON.LineString): LatLng[] =>
  (g.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng }));

function empty(unroutable: Unroutable): FlockCalcResult {
  return { routes: [], sharedSegments: [], flockRoute: null, waypointEtas: null, summary: { totalTogetherMinutes: 0, pairwiseSummary: [] }, warnings: [], unroutable, skipped: unroutable != null };
}

export async function calculateRoutes(session: FlockSession): Promise<FlockCalcResult> {
  const participants = session.participants;
  const waypoints = session.waypoints ?? [];
  if (participants.length === 0) return empty({ reason: "no-participants" });

  const wpById = new Map(waypoints.map((w) => [w.id, w]));
  // The FIXED location a pin resolves to (auto = free = null) — what the spine is built FROM.
  const pinLoc = (pin: LocationPin): LatLng | null =>
    pin.kind === "manual" ? pin.location : pin.kind === "waypoint" ? wpById.get(pin.waypointId)?.location ?? null : null;
  const targetKm = session.intendedDistanceKm != null ? Math.min(session.intendedDistanceKm, MAX_RUN_KM) : null;

  // The shared spine is an OUTPUT of the runners: chosen from their anchors, not from the
  // waypoints alone. null = no geography at all (no waypoints, no pins) → a NAMED no-route.
  const { route } = await buildSpine({
    waypoints: waypoints.map((w) => ({ id: w.id, location: w.location, name: w.name, stopMinutes: w.stopMinutes })),
    runners: participants.map((p) => ({ startLoc: pinLoc(p.startPin), finishLoc: pinLoc(p.finishPin), maxDistanceKm: p.maxDistanceKm })),
    targetKm,
  });
  if (!route) return empty({ reason: "no-location" });

  // Resolve a NON-manual pin (auto = free; waypoint = fixed at its pass; a vanished waypoint = free).
  // A FINISH waypoint uses lastNearKm (its LATEST pass) so a finish at the loop's base lands at km L,
  // not km 0 (which would collapse the window). A MANUAL pin is decided cap-aware in the loop below.
  const resolveFixed = (pin: LocationPin, role: "start" | "finish"): Bound => {
    if (pin.kind === "waypoint") {
      const w = wpById.get(pin.waypointId);
      if (w) return { kind: "fixed", km: role === "finish" ? lastNearKm(route, w.location) : nearestKm(route, w.location) };
    }
    return { kind: "free" };
  };
  // Arc position a bound sits at, for the "does the whole shared route fit your cap?" span: a fixed
  // bound is its km; a FREE end reaches the spine's far endpoint (0 for a start, L for a finish).
  const boundKm = (b: Bound, role: "start" | "finish"): number => (b.kind === "fixed" ? b.km : role === "finish" ? route.totalKm : 0);
  // The ORS connector leg between a manual home pin and an arc point — home→enter (approach) or
  // exit→home (egress) — with its distance + geometry. Best-effort: a failed calc leaves it implicit.
  const legTo = async (home: LatLng, km: number, role: "start" | "finish"): Promise<{ km: number; geom?: LatLng[] }> => {
    try {
      const r = await getRoute(role === "finish" ? [pointAtKm(route, km), home] : [home, pointAtKm(route, km)]);
      return { km: r.distanceKm, geom: geomToLatLng(r.geometry) };
    } catch {
      return { km: 0 };
    }
  };
  // Where a manual pin joins the spine, chosen to MAXIMISE shared distance within the runner's cap —
  // ONE continuous rule, no waypoint-count cases. At each candidate arc point the runner can share
  // min(reach, cap − commute − otherCommute) of the route, where `reach` is the arc from that point to
  // the OTHER end and `commute` is the home→point hop (a cheap straight-line proxy; the real road leg
  // is computed once, for the winner). Sweeping it lands the join exactly where coverage peaks:
  //   • no cap → the spine ENDPOINT (commute is free to ignore, so reach is maximal → the whole route);
  //   • a slack cap → still the endpoint (reach saturates before the budget bites);
  //   • a tight cap → pulled toward home (shorter commute buys more shared arc), i.e. a sub-segment;
  //   • too tight for any shared arc → coverage 0 everywhere → classify() parks them, named.
  const totalKm = route.totalKm;
  const optimalManualKm = (home: LatLng, role: "start" | "finish", otherEndKm: number, otherCommuteKm: number, cap: number | null): number => {
    const endpoint = role === "finish" ? totalKm : 0;
    if (cap == null) return endpoint;
    const lo = role === "finish" ? Math.max(0, Math.min(otherEndKm, totalKm)) : 0;
    const hi = role === "finish" ? totalKm : Math.max(0, Math.min(otherEndKm, totalKm));
    const N = 64;
    let bestKm = endpoint;
    let bestCov = -Infinity;
    for (let i = 0; i <= N; i++) {
      const km = lo + ((hi - lo) * i) / N;
      const commute = distanceMeters(home, pointAtKm(route, km)) / 1000;
      const reach = role === "finish" ? km - otherEndKm : otherEndKm - km;
      const cov = Math.min(Math.max(0, reach), cap - commute - otherCommuteKm);
      if (cov > bestCov + 1e-9) { bestCov = cov; bestKm = km; }
    }
    return bestKm;
  };
  // BOTH ends are off-route homes: choose the two join points TOGETHER (a greedy per-end choice drifts
  // them apart and trips a false cap conflict). Sweep (enter ≤ exit), keeping the longest shared arc
  // whose total — commute(start→enter) + arc + commute(exit→finish) — fits the cap. No cap → the whole
  // spine. If NOTHING fits (even zero arc), park them at the point nearest BOTH homes so classify's
  // cap-too-short names it (their commute alone busts the cap). Straight-line commute proxy; real road
  // legs are ORS'd for the winners.
  const jointManualKm = (startHome: LatLng, finishHome: LatLng, cap: number | null, scaleS = 1, scaleF = 1): { enterKm: number; exitKm: number } => {
    if (cap == null) return { enterKm: 0, exitKm: totalKm };
    const N = 48;
    const ce: number[] = [], cx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const p = pointAtKm(route, (totalKm * i) / N);
      // scaleS/scaleF inflate the straight-line proxy to the measured road-detour ratio (1 = raw).
      ce.push((scaleS * distanceMeters(startHome, p)) / 1000);
      cx.push((scaleF * distanceMeters(finishHome, p)) / 1000);
    }
    let best = { enterKm: 0, exitKm: 0, arc: -1 };
    for (let i = 0; i <= N; i++)
      for (let j = i; j <= N; j++) {
        const arc = (totalKm * (j - i)) / N;
        if (ce[i] + arc + cx[j] > cap + 1e-9) continue;
        if (arc > best.arc) best = { enterKm: (totalKm * i) / N, exitKm: (totalKm * j) / N, arc };
      }
    if (best.arc >= 0) return { enterKm: best.enterKm, exitKm: best.exitKm };
    let p = { km: 0, c: Infinity };
    for (let i = 0; i <= N; i++) if (ce[i] + cx[i] < p.c) p = { km: (totalKm * i) / N, c: ce[i] + cx[i] };
    return { enterKm: p.km, exitKm: p.km };
  };

  const connectors = new Map<string, Connectors>();
  const runners: Runner[] = await Promise.all(
    participants.map(async (p): Promise<Runner> => {
      // Guard against non-finite / non-positive pace (UI-unreachable, but pathological API input
      // would otherwise flow NaN/Infinity into the clock math and break HH:MM).
      const pace = Number.isFinite(p.pace) && (p.pace as number) > 0 ? (p.pace as number) : DEFAULT_PACE;
      const cap = p.maxDistanceKm != null ? Math.max(0, p.maxDistanceKm) : null; // clamp pathological negatives
      const startHome = p.startPin.kind === "manual" ? p.startPin.location : null;
      const finishHome = p.finishPin.kind === "manual" ? p.finishPin.location : null;

      let enter = resolveFixed(p.startPin, "start");
      let exit = resolveFixed(p.finishPin, "finish");
      const conn: Connectors = {};
      let approachKm = 0;
      let egressKm = 0;

      // A manual pin marks where the runner comes FROM (home), off the shared route — where they JOIN
      // the spine is an engine CHOICE, placed to spend as much of the route with the flock as the cap
      // allows. BOTH manual → choose the two joins JOINTLY (jointManualKm); ONE manual → the single
      // join, the other (free) end resolved later (optimalManualKm). A straight-line commute proxy
      // steers the choice; the real road leg is ORS'd for the winner.
      if (startHome && finishHome) {
        let { enterKm, exitKm } = jointManualKm(startHome, finishHome, cap);
        let sLeg = await legTo(startHome, enterKm, "start");
        let fLeg = await legTo(finishHome, exitKm, "finish");
        // jointManualKm chose with a STRAIGHT-LINE commute proxy; the REAL road legs are longer, so the
        // arc can overrun the cap. Correct ONCE (not an ORS-hungry loop — the quota is tight): measure
        // the road-detour ratio from these two legs, re-pick the joins with the proxy scaled to it, and
        // recompute the legs there. ≤2 extra calls, and only when a cap actually binds on real roads.
        if (cap != null && sLeg.km + (exitKm - enterKm) + fLeg.km > cap + 1e-6) {
          const havS = distanceMeters(startHome, pointAtKm(route, enterKm)) / 1000;
          const havF = distanceMeters(finishHome, pointAtKm(route, exitKm)) / 1000;
          const scaleS = havS > 1e-6 ? sLeg.km / havS : 1;
          const scaleF = havF > 1e-6 ? fLeg.km / havF : 1;
          ({ enterKm, exitKm } = jointManualKm(startHome, finishHome, cap, scaleS, scaleF));
          sLeg = await legTo(startHome, enterKm, "start");
          fLeg = await legTo(finishHome, exitKm, "finish");
        }
        enter = { kind: "fixed", km: enterKm };
        exit = { kind: "fixed", km: exitKm };
        approachKm = sLeg.km;
        egressKm = fLeg.km;
        if (sLeg.geom) conn.approach = sLeg.geom;
        if (fLeg.geom) conn.egress = fLeg.geom;
      } else if (startHome) {
        const km = optimalManualKm(startHome, "start", boundKm(exit, "finish"), 0, cap);
        const leg = await legTo(startHome, km, "start");
        enter = { kind: "fixed", km };
        approachKm = leg.km;
        if (leg.geom) conn.approach = leg.geom;
      } else if (finishHome) {
        const km = optimalManualKm(finishHome, "finish", boundKm(enter, "start"), 0, cap);
        const leg = await legTo(finishHome, km, "finish");
        exit = { kind: "fixed", km };
        egressKm = leg.km;
        if (leg.geom) conn.egress = leg.geom;
      }
      if (conn.approach || conn.egress) connectors.set(p.id, conn);
      return {
        id: p.id,
        pace,
        enter,
        exit,
        maxDistanceKm: cap,
        earliestSec: p.earliestStartTime != null ? timeToSec(p.earliestStartTime) : null,
        latestSec: p.latestFinishTime != null ? timeToSec(p.latestFinishTime) : null,
        approachKm,
        egressKm,
        // A WAYPOINT pin is a HARD arc constraint; a manual join is the engine's choice (not hard).
        hardEnter: p.startPin.kind === "waypoint",
        hardExit: p.finishPin.kind === "waypoint",
      };
    }),
  );

  // Resolve the flock's departure from the time anchor.
  const anchor = session.startAnchor ?? { kind: "auto" as const };
  const anchorWp = anchor.kind === "waypoint" ? wpById.get(anchor.waypointId) : undefined;
  let t0Sec: number;
  if (anchor.kind === "departure") {
    t0Sec = timeToSec(anchor.time);
  } else if (anchor.kind === "waypoint" && anchorWp) {
    const km = nearestKm(route, anchorWp.location);
    const slowest = Math.max(DEFAULT_PACE, ...runners.map((r) => r.pace));
    const dwellSec = route.stops.reduce((s, st) => s + st.durationSec, 0);
    // Back-compute t0 so the flock REACHES the anchor waypoint at anchor.time (Cause D). A closed-form
    // km·pace ignores the upstream dwell + slowest-present pace, and an offset step can oscillate when a
    // constraint clip makes arrival − t0 jump — but arrivalAt(blocks, km) is MONOTONE non-decreasing in
    // t0, so BISECT for the smallest t0 whose flock arrival reaches anchor.time (robust to those kinks).
    const target = timeToSec(anchor.time);
    const arriveAtKm = (cand: number) => arrivalAt(planRun({ route, runners, t0Sec: cand }).blocks, km);
    let lo = target - km * slowest - dwellSec - 600, hi = target; // arrival(hi=target) ≥ target (≥ t0)
    for (let g = 0; arriveAtKm(lo) >= target && g < 20; g++) lo -= 3600; // ensure arrival(lo) < target
    for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (arriveAtKm(mid) < target) lo = mid; else hi = mid; }
    t0Sec = hi;
  } else {
    // Auto (or a waypoint anchor whose waypoint vanished): derive a sensible flock start from
    // the runners' constraints — and stay at 07:00 when there's nothing to derive from.
    t0Sec = resolveAutoStart(route, runners);
  }

  const plan = planRun({ route, runners, t0Sec });
  return projectPlan({ plan, route, runners, waypoints: waypoints.map((w) => ({ id: w.id, location: w.location })), connectors });
}
