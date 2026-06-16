// ---------------------------------------------------------------------------
// Flock Route (the shared "backbone") — the 1-D track the flock flies together
// along. Built ONCE from the nominated waypoints, or auto-generated when none.
// Carries cumulative arc-length so a runner's participation reduces to a
// [enterKm, exitKm] interval, and provides arc → point / slice helpers.
//
// km 0 is the rendezvous: where the flock gathers and the flock clock starts.
// ---------------------------------------------------------------------------

import { distanceMeters } from "./geo";
import { createLogger } from "./logger";
import { getRoundTrip, getRoute, type OrsRoute } from "./ors";
import type { FlockWaypoint, LatLng } from "./types";

const log = createLogger("flock-route");

export interface Backbone {
  rendezvous: LatLng; // km 0 — where the flock gathers
  coords: LatLng[]; // backbone polyline
  cumKm: number[]; // cumulative km at each vertex
  totalKm: number;
  stops: { km: number; durationSec: number; name: string; location: LatLng }[];
}

export function centroid(pts: LatLng[]): LatLng {
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
  return { lat, lng };
}

/** Point at arc-distance `km` along the backbone (linear interpolation). */
export function pointAtKm(b: Backbone, km: number): LatLng {
  const t = Math.max(0, Math.min(km, b.totalKm));
  let i = 1;
  while (i < b.cumKm.length && b.cumKm[i] < t) i++;
  if (i >= b.coords.length) return b.coords[b.coords.length - 1];
  const k0 = b.cumKm[i - 1];
  const k1 = b.cumKm[i];
  const f = k1 > k0 ? (t - k0) / (k1 - k0) : 0;
  const a = b.coords[i - 1];
  const c = b.coords[i];
  return { lat: a.lat + (c.lat - a.lat) * f, lng: a.lng + (c.lng - a.lng) * f };
}

/** Polyline of the backbone between two arc-distances. */
export function sliceKm(b: Backbone, fromKm: number, toKm: number): LatLng[] {
  const lo = Math.max(0, Math.min(fromKm, toKm));
  const hi = Math.min(b.totalKm, Math.max(fromKm, toKm));
  const out: LatLng[] = [pointAtKm(b, lo)];
  for (let i = 0; i < b.coords.length; i++) {
    if (b.cumKm[i] > lo + 1e-9 && b.cumKm[i] < hi - 1e-9) out.push(b.coords[i]);
  }
  out.push(pointAtKm(b, hi));
  return out;
}

/** Arc-distance (km) of the backbone vertex nearest to `ll`. */
export function nearestKm(b: Backbone, ll: LatLng): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < b.coords.length; i++) {
    const d = distanceMeters(b.coords[i], ll);
    if (d < bestD) {
      bestD = d;
      best = b.cumKm[i];
    }
  }
  return best;
}

function fromOrs(ors: OrsRoute): Pick<Backbone, "coords" | "cumKm" | "totalKm"> {
  const coords: LatLng[] = (ors.geometry.coordinates as [number, number][]).map(([lng, lat]) => ({
    lat,
    lng,
  }));
  const cumKm = [0];
  for (let i = 1; i < coords.length; i++) {
    cumKm.push(cumKm[i - 1] + distanceMeters(coords[i - 1], coords[i]) / 1000);
  }
  return { coords, cumKm, totalKm: cumKm[cumKm.length - 1] };
}

export async function buildBackbone(opts: {
  waypoints: FlockWaypoint[];
  starts: LatLng[];
  targetKm: number;
}): Promise<Backbone> {
  const { waypoints, starts, targetKm } = opts;

  let rendezvous: LatLng;
  let geom: Pick<Backbone, "coords" | "cumKm" | "totalKm">;

  if (waypoints.length >= 2) {
    // Backbone follows the nominated waypoints in order; km 0 = first waypoint.
    rendezvous = waypoints[0].location;
    geom = fromOrs(await getRoute(waypoints.map((w) => w.location)));
  } else {
    // Auto / single-waypoint: a loop from the rendezvous sized to the target.
    rendezvous = waypoints.length === 1 ? waypoints[0].location : centroid(starts);
    geom = fromOrs(await getRoundTrip(rendezvous, Math.max(1, targetKm)));
  }

  const backbone: Backbone = { rendezvous, ...geom, stops: [] };

  // Snap any stop-waypoints onto the backbone.
  backbone.stops = waypoints
    .filter((w) => w.stopMinutes > 0)
    .map((w) => ({
      km: nearestKm(backbone, w.location),
      durationSec: w.stopMinutes * 60,
      name: w.name,
      location: w.location,
    }))
    .sort((a, b) => a.km - b.km);

  log.info("backbone built", {
    source: waypoints.length >= 2 ? "waypoints" : waypoints.length === 1 ? "single-waypoint" : "auto",
    totalKm: Number(backbone.totalKm.toFixed(2)),
    stops: backbone.stops.length,
  });

  return backbone;
}
