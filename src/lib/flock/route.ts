// ---------------------------------------------------------------------------
// Flock — build the shared route (the spine the flock runs) and the arc helpers the
// planner + projection read. ORS lives only here. Self-contained: no dependency on the
// legacy flockRoute.ts (which is being superseded).
//
//   ≥2 waypoints → the ordered tour (a corridor), optionally grown to the run distance
//   1 waypoint   → a loop based at it, sized to the run distance (default 10 km)
//   0 waypoints  → a loop from a given origin, same sizing
// Stops (waypoints with a dwell) are snapped onto the route by segment projection.
// ---------------------------------------------------------------------------

import { centroid, closestPointOnSegment, distanceMeters } from "../geo";
import { getRoundTrip, getRoute, type OrsRoute } from "../ors";
import type { LatLng } from "../types";
import type { Route, Stop } from "./model";

const DEFAULT_DISTANCE_KM = 10;
const MIN_GROW_KM = 1.5;
// A finish pin within this much (m) of the route's closest approach counts as the SAME place,
// so lastNearKm can pick the latest such pass (the return of a loop / there-and-back).
const REVISIT_TOL_M = 120;

// --- arc helpers (shared with projection) -----------------------------------
export function withCum(coords: LatLng[]): Pick<Route, "coords" | "cumKm" | "totalKm"> {
  const cumKm = [0];
  for (let i = 1; i < coords.length; i++) cumKm.push(cumKm[i - 1] + distanceMeters(coords[i - 1], coords[i]) / 1000);
  return { coords, cumKm, totalKm: cumKm[cumKm.length - 1] };
}
export function pointAtKm(r: Pick<Route, "coords" | "cumKm" | "totalKm">, km: number): LatLng {
  const t = Math.max(0, Math.min(km, r.totalKm));
  let i = 1;
  while (i < r.cumKm.length && r.cumKm[i] < t) i++;
  if (i >= r.coords.length) return r.coords[r.coords.length - 1];
  const k0 = r.cumKm[i - 1];
  const f = r.cumKm[i] > k0 ? (t - k0) / (r.cumKm[i] - k0) : 0;
  const a = r.coords[i - 1];
  const c = r.coords[i];
  return { lat: a.lat + (c.lat - a.lat) * f, lng: a.lng + (c.lng - a.lng) * f };
}
export function sliceKm(r: Pick<Route, "coords" | "cumKm" | "totalKm">, fromKm: number, toKm: number): LatLng[] {
  const lo = Math.max(0, Math.min(fromKm, toKm));
  const hi = Math.min(r.totalKm, Math.max(fromKm, toKm));
  const out: LatLng[] = [pointAtKm(r, lo)];
  for (let i = 0; i < r.coords.length; i++) if (r.cumKm[i] > lo + 1e-9 && r.cumKm[i] < hi - 1e-9) out.push(r.coords[i]);
  out.push(pointAtKm(r, hi));
  return out;
}
// arc position closest to `ll` by segment projection; first (lowest-km) pass wins on a
// route that revisits a point, keeping a stop on the outbound pass.
export function nearestKm(r: Pick<Route, "coords" | "cumKm">, ll: LatLng): number {
  let bestKm = 0;
  let bestD = Infinity;
  for (let i = 0; i < r.coords.length - 1; i++) {
    const foot = closestPointOnSegment(ll, r.coords[i], r.coords[i + 1]);
    const d = distanceMeters(ll, foot);
    if (d < bestD) {
      bestD = d;
      bestKm = r.cumKm[i] + distanceMeters(r.coords[i], foot) / 1000;
    }
  }
  return bestKm;
}

// Like nearestKm, but returns the FARTHEST-along pass whose closest approach is within
// REVISIT_TOL of the global minimum. For a FINISH pin on a route that revisits its start
// (a loop / there-and-back), this resolves to the RETURN pass instead of km≈0 — so a finish
// near the start doesn't collapse the runner's window. On a non-revisiting route it equals
// nearestKm (a single pass). Starts/waypoints keep nearestKm (the first/earliest pass).
export function lastNearKm(r: Pick<Route, "coords" | "cumKm">, ll: LatLng): number {
  let bestD = Infinity;
  for (let i = 0; i < r.coords.length - 1; i++)
    bestD = Math.min(bestD, distanceMeters(ll, closestPointOnSegment(ll, r.coords[i], r.coords[i + 1])));
  let km = 0;
  for (let i = 0; i < r.coords.length - 1; i++) {
    const foot = closestPointOnSegment(ll, r.coords[i], r.coords[i + 1]);
    if (distanceMeters(ll, foot) <= bestD + REVISIT_TOL_M)
      km = Math.max(km, r.cumKm[i] + distanceMeters(r.coords[i], foot) / 1000);
  }
  return km;
}

function fromOrs(ors: OrsRoute): Pick<Route, "coords" | "cumKm" | "totalKm"> {
  const coords: LatLng[] = (ors.geometry.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng }));
  return withCum(coords);
}
function truncateToKm(geom: Pick<Route, "coords" | "cumKm" | "totalKm">, km: number): LatLng[] {
  if (km >= geom.totalKm) return geom.coords;
  const out: LatLng[] = [];
  for (let i = 0; i < geom.coords.length; i++) {
    if (geom.cumKm[i] <= km) out.push(geom.coords[i]);
    else {
      const k0 = geom.cumKm[i - 1];
      const f = geom.cumKm[i] > k0 ? (km - k0) / (geom.cumKm[i] - k0) : 0;
      const a = geom.coords[i - 1];
      const b = geom.coords[i];
      out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
      break;
    }
  }
  return out;
}

export interface WaypointSpec {
  id: string;
  location: LatLng;
  name: string;
  stopMinutes: number;
}

const loopKm = (cap: number | null, targetKm: number | null) => Math.max(1, cap ?? targetKm ?? DEFAULT_DISTANCE_KM);

// A corridor through ordered points, optionally grown by a loop off the end to reach targetKm.
async function corridor(points: LatLng[], targetKm: number | null): Promise<Pick<Route, "coords" | "cumKm" | "totalKm">> {
  const base = fromOrs(await getRoute(points));
  if (targetKm != null && targetKm - base.totalKm > MIN_GROW_KM) {
    try {
      const last = base.coords[base.coords.length - 1];
      const loop = fromOrs(await getRoundTrip(last, targetKm - base.totalKm));
      return withCum(base.coords.concat(truncateToKm(loop, targetKm - base.totalKm).slice(1)));
    } catch {
      return base; // better a short tour than a failed calc
    }
  }
  return base;
}

// Snap the dwell stops (waypoints with a positive stop) onto a finished geometry.
function withStops(geom: Pick<Route, "coords" | "cumKm" | "totalKm">, waypoints: WaypointSpec[]): Route {
  const base: Route = { ...geom, stops: [] };
  base.stops = waypoints
    .filter((w) => w.stopMinutes > 0)
    .map((w): Stop => ({ km: nearestKm(base, w.location), durationSec: w.stopMinutes * 60, name: w.name }))
    .sort((a, b) => a.km - b.km);
  return base;
}

/**
 * Legacy builder: ≥2 waypoints → corridor; ≤1 → loop at the waypoint/origin. Kept for the
 * e2e test and back-compat. `buildSpine` is the model entry point (route as an OUTPUT).
 */
export async function buildRoute(opts: { waypoints: WaypointSpec[]; origin?: LatLng; targetKm?: number | null }): Promise<Route> {
  const { waypoints, origin, targetKm } = opts;
  let geom: Pick<Route, "coords" | "cumKm" | "totalKm">;
  if (waypoints.length >= 2) {
    geom = await corridor(waypoints.map((w) => w.location), targetKm ?? null);
  } else {
    const center = waypoints[0]?.location ?? origin;
    if (!center) throw new Error("buildRoute: no waypoint and no origin to anchor a loop");
    geom = fromOrs(await getRoundTrip(center, Math.max(1, targetKm ?? DEFAULT_DISTANCE_KM)));
  }
  return withStops(geom, waypoints);
}

export interface SpineRunner {
  startLoc: LatLng | null; // a FIXED start location (manual pin / waypoint); null = free (auto)
  finishLoc: LatLng | null; // a FIXED finish location; null = free
  maxDistanceKm: number | null; // sizes a single runner's loop when their finish is free
}

/**
 * Choose the shared spine as an OUTPUT of the runners, not an input. The geometry is a near-
 * deterministic function of the anchor set — waypoints ∪ the runners' FIXED pins ∪ a derived
 * meeting point — so every combination yields a sensible route, or `null` when there is no
 * geography at all. One spine for the whole flock (runners join/leave + commute via connectors).
 *
 *   ≥2 waypoints                       → the organizer's corridor; runners join it.        [W]
 *   exactly 1 runner                   → that runner's OWN route (corridor A→B, or a loop). [C]
 *   ≥1 fixed start AND ≥1 fixed finish → corridor centroid(starts) → centroid(finishes).   [A]
 *   some fixed anchor but free ends    → a loop at the meeting point (centroid of anchors). [B]
 *   no fixed anchor at all             → null (nothing to route from).                     [D]
 */
export async function buildSpine(opts: { waypoints: WaypointSpec[]; runners: SpineRunner[]; targetKm: number | null }): Promise<Route | null> {
  const { waypoints, runners, targetKm } = opts;
  if (waypoints.length >= 2) return buildRoute({ waypoints, targetKm }); // [W] honor the organizer's route

  const wp = waypoints[0]?.location ?? null;
  const fixedStarts = runners.map((r) => r.startLoc).filter((l): l is LatLng => l != null);
  const fixedFinishes = runners.map((r) => r.finishLoc).filter((l): l is LatLng => l != null);
  const allFixed = [...fixedStarts, ...fixedFinishes, ...(wp ? [wp] : [])];

  let geom: Pick<Route, "coords" | "cumKm" | "totalKm"> | null = null;

  if (runners.length === 1) {
    const { startLoc, finishLoc, maxDistanceKm } = runners[0]; // [C] the runner's own route
    if (startLoc && finishLoc) geom = await corridor([startLoc, ...(wp ? [wp] : []), finishLoc], null); // literal A→B (no grow)
    else if (startLoc) geom = fromOrs(await getRoundTrip(startLoc, loopKm(maxDistanceKm, targetKm)));
    else if (finishLoc) geom = fromOrs(await getRoundTrip(finishLoc, loopKm(maxDistanceKm, targetKm)));
    else if (wp) geom = fromOrs(await getRoundTrip(wp, loopKm(maxDistanceKm, targetKm)));
  } else if (fixedStarts.length > 0 && fixedFinishes.length > 0 && distanceMeters(centroid(fixedStarts), centroid(fixedFinishes)) >= 1) {
    geom = await corridor([centroid(fixedStarts), ...(wp ? [wp] : []), centroid(fixedFinishes)], targetKm); // [A]
  } else if (allFixed.length > 0) {
    geom = fromOrs(await getRoundTrip(centroid(allFixed), Math.max(1, targetKm ?? DEFAULT_DISTANCE_KM))); // [B]
  }

  return geom ? withStops(geom, waypoints) : null; // null = [D] no geography
}
