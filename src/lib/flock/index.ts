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

import { getRoute } from "../ors";
import type { FlockSession, LatLng, LocationPin } from "../types";
import { timeToSec } from "../units";
import type { Bound, Route, Runner } from "./model";
import { planRun, resolveAutoStart } from "./plan";
import { projectPlan, type Connectors, type FlockCalcResult } from "./project";
import { buildRoute, nearestKm, pointAtKm } from "./route";

const DEFAULT_PACE = 360; // 6:00/km
// Clamp an absurd intended distance so a route can't span more than a day (the UI slider tops
// out at 80 km; this only bites pathological API input). Keeps the wall clock single-day.
const MAX_RUN_KM = 200;

const geomToLatLng = (g: GeoJSON.LineString): LatLng[] =>
  (g.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng }));

function empty(skipped: boolean): FlockCalcResult {
  return { routes: [], sharedSegments: [], flockRoute: null, waypointEtas: null, summary: { totalTogetherMinutes: 0, pairwiseSummary: [] }, warnings: [], skipped };
}

export async function calculateRoutes(session: FlockSession): Promise<FlockCalcResult> {
  const participants = session.participants;
  const waypoints = session.waypoints ?? [];
  if (participants.length === 0) return empty(true);

  // Origin for the ≤1-waypoint loop / no-waypoint fallback: the first waypoint, else the
  // first manual pin. With neither, there's no geography to route — skip.
  const firstManual = participants
    .flatMap((p) => [p.startPin, p.finishPin])
    .find((pin): pin is Extract<LocationPin, { kind: "manual" }> => pin.kind === "manual");
  const origin: LatLng | undefined = waypoints[0]?.location ?? firstManual?.location;
  if (waypoints.length === 0 && !origin) return empty(true);

  const route: Route = await buildRoute({
    waypoints: waypoints.map((w) => ({ id: w.id, location: w.location, name: w.name, stopMinutes: w.stopMinutes })),
    origin,
    targetKm: session.intendedDistanceKm != null ? Math.min(session.intendedDistanceKm, MAX_RUN_KM) : null,
  });

  // Resolve a pin to an arc bound; a manual pin also yields a connector point off the route.
  const wpById = new Map(waypoints.map((w) => [w.id, w]));
  const resolve = (pin: LocationPin): { bound: Bound; connector?: LatLng } => {
    if (pin.kind === "auto") return { bound: { kind: "free" } };
    if (pin.kind === "waypoint") {
      const w = wpById.get(pin.waypointId);
      return w ? { bound: { kind: "fixed", km: nearestKm(route, w.location) } } : { bound: { kind: "free" } };
    }
    return { bound: { kind: "fixed", km: nearestKm(route, pin.location) }, connector: pin.location };
  };

  const connectors = new Map<string, Connectors>();
  const runners: Runner[] = await Promise.all(
    participants.map(async (p): Promise<Runner> => {
      // Guard against non-finite / non-positive pace (UI-unreachable, but pathological API input
      // would otherwise flow NaN/Infinity into the clock math and break HH:MM).
      const pace = Number.isFinite(p.pace) && (p.pace as number) > 0 ? (p.pace as number) : DEFAULT_PACE;
      const s = resolve(p.startPin);
      const f = resolve(p.finishPin);
      let approachKm = 0;
      let egressKm = 0;
      const conn: Connectors = {};
      if (s.connector && s.bound.kind === "fixed") {
        try {
          const r = await getRoute([s.connector, pointAtKm(route, s.bound.km)]);
          conn.approach = geomToLatLng(r.geometry);
          approachKm += r.distanceKm;
        } catch { /* leave the connector implicit */ }
      }
      if (f.connector && f.bound.kind === "fixed") {
        try {
          const r = await getRoute([pointAtKm(route, f.bound.km), f.connector]);
          conn.egress = geomToLatLng(r.geometry);
          egressKm += r.distanceKm;
        } catch { /* leave the connector implicit */ }
      }
      if (conn.approach || conn.egress) connectors.set(p.id, conn);
      return {
        id: p.id,
        pace,
        enter: s.bound,
        exit: f.bound,
        maxDistanceKm: p.maxDistanceKm,
        earliestSec: p.earliestStartTime != null ? timeToSec(p.earliestStartTime) : null,
        latestSec: p.latestFinishTime != null ? timeToSec(p.latestFinishTime) : null,
        approachKm,
        egressKm,
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
    t0Sec = timeToSec(anchor.time) - km * slowest; // back-compute so the flock reaches the waypoint on time
  } else {
    // Auto (or a waypoint anchor whose waypoint vanished): derive a sensible flock start from
    // the runners' constraints — and stay at 07:00 when there's nothing to derive from.
    t0Sec = resolveAutoStart(route, runners);
  }

  const plan = planRun({ route, runners, t0Sec });
  return projectPlan({ plan, route, runners, waypoints: waypoints.map((w) => ({ id: w.id, location: w.location })), connectors });
}
