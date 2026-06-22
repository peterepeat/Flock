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

import { closestPointOnSegment, distanceMeters } from "../geo";
import { getRoundTrip, getRoute, type OrsRoute } from "../ors";
import type { LatLng } from "../types";
import type { Route, Stop } from "./model";

const DEFAULT_DISTANCE_KM = 10;
const MIN_GROW_KM = 1.5;

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

/**
 * Build the shared route. `targetKm` is the run's intended distance (set, or null → tour
 * length / default loop). `origin` anchors the ≤1-waypoint loop and the no-waypoint case.
 */
export async function buildRoute(opts: {
  waypoints: WaypointSpec[];
  origin?: LatLng;
  targetKm?: number | null;
}): Promise<Route> {
  const { waypoints, origin, targetKm } = opts;
  let geom: Pick<Route, "coords" | "cumKm" | "totalKm">;

  if (waypoints.length >= 2) {
    const corridor = fromOrs(await getRoute(waypoints.map((w) => w.location)));
    geom = corridor;
    // Grow to the run's intended distance only if it's meaningfully longer than the tour.
    if (targetKm != null && targetKm - corridor.totalKm > MIN_GROW_KM) {
      try {
        const last = corridor.coords[corridor.coords.length - 1];
        const loop = fromOrs(await getRoundTrip(last, targetKm - corridor.totalKm));
        geom = withCum(corridor.coords.concat(truncateToKm(loop, targetKm - corridor.totalKm).slice(1)));
      } catch {
        geom = corridor; // better a short tour than a failed calc
      }
    }
  } else {
    const center = waypoints[0]?.location ?? origin;
    if (!center) throw new Error("buildRoute: no waypoint and no origin to anchor a loop");
    geom = fromOrs(await getRoundTrip(center, Math.max(1, targetKm ?? DEFAULT_DISTANCE_KM)));
  }

  const base: Route = { ...geom, stops: [] };
  base.stops = waypoints
    .filter((w) => w.stopMinutes > 0)
    .map((w): Stop => ({ km: nearestKm(base, w.location), durationSec: w.stopMinutes * 60, name: w.name }))
    .sort((a, b) => a.km - b.km);
  return base;
}
