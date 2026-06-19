// ---------------------------------------------------------------------------
// Flock Route (the shared "backbone") — the 1-D track the flock runs together
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

// Don't bother growing a waypoint corridor for a deficit smaller than this — a
// sub-1.5km loop isn't worth the ORS call (mirrors MIN_EXTENSION_KM in the engine).
const MIN_GROW_KM = 1.5;

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

/** The polyline truncated to the first `km` of arc-length (interpolating the cut
    point), so an ORS round-trip that overshoots its requested length doesn't draw
    spine the runners won't actually cover. Returns the whole thing if it's shorter. */
function truncateToKm(geom: Pick<Backbone, "coords" | "cumKm" | "totalKm">, km: number): LatLng[] {
  if (km >= geom.totalKm) return geom.coords;
  const out: LatLng[] = [];
  for (let i = 0; i < geom.coords.length; i++) {
    if (geom.cumKm[i] <= km) {
      out.push(geom.coords[i]);
    } else {
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

/** Build cumulative arc-length over a polyline. */
function withCum(coords: LatLng[]): Pick<Backbone, "coords" | "cumKm" | "totalKm"> {
  const cumKm = [0];
  for (let i = 1; i < coords.length; i++) {
    cumKm.push(cumKm[i - 1] + distanceMeters(coords[i - 1], coords[i]) / 1000);
  }
  return { coords, cumKm, totalKm: cumKm[cumKm.length - 1] };
}

function fromOrs(ors: OrsRoute): Pick<Backbone, "coords" | "cumKm" | "totalKm"> {
  const coords: LatLng[] = (ors.geometry.coordinates as [number, number][]).map(([lng, lat]) => ({
    lat,
    lng,
  }));
  return withCum(coords);
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
    const corridor = fromOrs(await getRoute(waypoints.map((w) => w.location)));
    geom = corridor;
    // Grow the shared spine to the two-longest runners' reach (targetKm) so the
    // flock runs together as far as they can handle — the waypoints stay anchors
    // ON a longer route rather than capping it. We append ONE loop at the LAST
    // waypoint: this keeps every waypoint's arc position fixed (ETAs, stop dwell
    // and snapping below are untouched) and reuses the same round-trip primitive
    // the solo extension already relies on. A long corridor (deficit ≤ 0) is left
    // as-is — shorter runners just peel off early.
    const deficit = targetKm - corridor.totalKm;
    if (deficit > MIN_GROW_KM) {
      try {
        const last = waypoints[waypoints.length - 1].location;
        const loop = fromOrs(await getRoundTrip(last, deficit));
        // Bound the loop to the requested deficit (ORS round-trips overshoot their
        // asked length): the grown spine lands at ~targetKm, so the two longest
        // cover the WHOLE of it (the never-solo invariant) and it stays within the
        // distance ceiling targetKm was clamped to. The loop starts at `last` ≈ the
        // corridor's end — drop its first vertex so the seam isn't a zero-length seg.
        const loopCoords = truncateToKm(loop, deficit);
        geom = withCum(corridor.coords.concat(loopCoords.slice(1)));
        log.info("backbone grown to reach", {
          corridorKm: Number(corridor.totalKm.toFixed(2)),
          targetKm: Number(targetKm.toFixed(2)),
          grownKm: Number(geom.totalKm.toFixed(2)),
        });
      } catch (err) {
        // ORS couldn't close a loop here — better a short shared route than a
        // failed calc; fall back to the plain corridor.
        log.warn("backbone grow failed — keeping waypoint corridor", { error: String(err) });
        geom = corridor;
      }
    }
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
