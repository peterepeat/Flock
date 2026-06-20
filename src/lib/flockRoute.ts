// ---------------------------------------------------------------------------
// Flock Route (the shared "backbone") — the 1-D track the flock runs together
// along. Built ONCE from the nominated waypoints, or auto-generated when none.
// Carries cumulative arc-length so a runner's participation reduces to a
// [enterKm, exitKm] interval, and provides arc → point / slice helpers.
//
// km 0 is the rendezvous: where the flock gathers and the flock clock starts.
// ---------------------------------------------------------------------------

import { distanceMeters, pointToSegmentMeters } from "./geo";
import { createLogger } from "./logger";
import { getRoundTrip, getRoute, type OrsRoute } from "./ors";
import type { FlockWaypoint, LatLng } from "./types";

const log = createLogger("flock-route");

// Don't bother growing a waypoint corridor for a deficit smaller than this — a
// sub-1.5km loop isn't worth the ORS call (mirrors MIN_EXTENSION_KM in the engine).
const MIN_GROW_KM = 1.5;

// --- Stage 0: computed formation point F (longest common tail of approaches) ----
// The convergence tree's degenerate, single-merge case. The rendezvous (km 0) used
// to be PINNED to the first waypoint; F pulls it back to where the runners' approach
// routes already coincide — the shared road they were all funnelling down — so that
// stretch becomes flock-together time instead of solo feeders. When origins diverge
// the common tail is short and F collapses to the first waypoint (today's behaviour).
//
// A canonical-path vertex counts as on the shared corridor when every OTHER runner's
// approach passes within this distance of it.
const FORMATION_TOLERANCE_M = 35;
// Don't pull the rendezvous back for a shared tail shorter than this — a sub-600m
// merge isn't worth re-anchoring the flock (mirrors MIN_GROW_KM / MIN_EXTENSION_KM).
// Exported: the engine gates its Phase-B rebuild on the same threshold.
export const FORMATION_MIN_MERGE_KM = 0.6;
// Walking the tail back from the waypoint it must keep heading AWAY from it; a
// momentary fold back toward it (a switchback / one-way pair) up to this far is
// tolerated before we call it a divergence.
const FORMATION_MONOTONE_SLACK_M = 60;

export interface Backbone {
  rendezvous: LatLng; // km 0 — where the flock gathers
  coords: LatLng[]; // backbone polyline
  cumKm: number[]; // cumulative km at each vertex
  totalKm: number;
  stops: { km: number; durationSec: number; name: string; location: LatLng }[];
  // The computed convergence points (Stage 0+). formationPoint = km 0 when the flock
  // gathers BEFORE the first waypoint (a real common tail fired); undefined ⇒ the
  // degenerate pinned case (== rendezvous == first waypoint). dispersalPoint is the
  // egress mirror, added by a later stage. Both optional so existing callers/stored
  // sessions are unaffected.
  formationPoint?: LatLng;
  dispersalPoint?: LatLng;
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

// --- computed formation point F --------------------------------------------

/** Total length (m) of a polyline. */
function lengthMeters(line: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += distanceMeters(line[i - 1], line[i]);
  return m;
}

/** Shortest distance (m) from `p` to a polyline (min over its segments). */
function pointToPolylineMeters(p: LatLng, line: LatLng[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = pointToSegmentMeters(p, line[i - 1], line[i]);
    if (d < best) best = d;
  }
  return best;
}

export interface FormationPoint {
  forkPoint: LatLng; // F — where the flock gathers (== wp0 when nothing fired)
  forkKm: number; // length of the shared F→wp0 tail (0 ⇒ disparate, leave the pin)
  sharedFromForkToWp0: LatLng[]; // the shared corridor polyline F→wp0 (≥2 pts when fired)
}

/**
 * The computed FORMATION POINT F: the start of the longest COMMON TAIL of the
 * runners' approach routes to the first waypoint — the shared road they were all
 * funnelling down anyway. Pure + ORS-free: it reads the approach geometry the engine
 * has ALREADY fetched.
 *
 * Method: take the longest approach as the canonical path and walk it BACKWARD from
 * the waypoint end, keeping the contiguous run of vertices where (a) every other
 * approach passes within FORMATION_TOLERANCE_M (nearest-segment distance, so vertex
 * misalignment between routes doesn't matter) and (b) the path keeps heading away
 * from the waypoint (a small fold-back is tolerated). F is the first vertex that
 * fails — snapped to a REAL canonical vertex, never freely interpolated, so F always
 * sits on an actually-routed road. When approaches diverge near the waypoint the tail
 * is shorter than FORMATION_MIN_MERGE_KM and F collapses to wp0 (forkKm 0).
 *
 * `approachGeoms` must be the routes of the rendezvous-joiners (each ending at ~wp0);
 * a runner joining deep in the corridor doesn't end at wp0 and must be excluded by
 * the caller.
 */
export function computeFormationPoint(approachGeoms: LatLng[][], wp0: LatLng): FormationPoint {
  const none: FormationPoint = { forkPoint: wp0, forkKm: 0, sharedFromForkToWp0: [] };
  const geoms = approachGeoms.filter((g) => g.length >= 2);
  if (geoms.length < 2) return none;

  // Canonical = the longest approach (most likely to span the whole shared tail);
  // every other approach is tested against its vertices.
  const canonical = geoms.reduce((a, b) => (lengthMeters(b) > lengthMeters(a) ? b : a));
  const others = geoms.filter((g) => g !== canonical);

  let forkIdx = canonical.length - 1; // last vertex ≈ wp0
  let maxDistToWp0 = distanceMeters(canonical[forkIdx], wp0);
  for (let i = canonical.length - 2; i >= 0; i--) {
    const v = canonical[i];
    if (!others.every((o) => pointToPolylineMeters(v, o) <= FORMATION_TOLERANCE_M)) break;
    const distToWp0 = distanceMeters(v, wp0);
    // The tail must keep heading away from wp0; tolerate a brief fold back toward it.
    if (distToWp0 < maxDistToWp0 - FORMATION_MONOTONE_SLACK_M) break;
    maxDistToWp0 = Math.max(maxDistToWp0, distToWp0);
    forkIdx = i;
  }

  const sharedFromForkToWp0 = canonical.slice(forkIdx);
  const forkKm = lengthMeters(sharedFromForkToWp0) / 1000;
  if (forkKm < FORMATION_MIN_MERGE_KM) return none;
  return { forkPoint: canonical[forkIdx], forkKm, sharedFromForkToWp0 };
}

/**
 * Prepend the shared F→wp0 tail to an already-built backbone, so km 0 becomes F and
 * the flock runs the shared corridor together. PURE (no ORS) — reuses the corridor +
 * any grown loop already in `backbone.coords`. Every arc position shifts forward by
 * the tail length; stops are re-snapped onto the new axis (their km changes). The
 * seam drops the backbone's first vertex (≈ the tail's last vertex, both the ORS-
 * snapped wp0), mirroring the grow-loop seam handling.
 */
export function prependFormationLead(backbone: Backbone, sharedTail: LatLng[], forkPoint: LatLng): Backbone {
  if (sharedTail.length < 2) return backbone;
  const coords = [...sharedTail, ...backbone.coords.slice(1)];
  const { cumKm, totalKm } = withCum(coords);
  const next: Backbone = {
    rendezvous: forkPoint,
    coords,
    cumKm,
    totalKm,
    stops: backbone.stops
      .map((s) => ({ ...s, km: nearestKm({ ...backbone, coords, cumKm, totalKm }, s.location) }))
      .sort((a, b) => a.km - b.km),
    formationPoint: forkPoint,
    dispersalPoint: backbone.dispersalPoint,
  };
  return next;
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
