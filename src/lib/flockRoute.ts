// ---------------------------------------------------------------------------
// Flock Route (the shared "backbone") — the 1-D track the flock runs together
// along. Built ONCE from the nominated waypoints, or auto-generated when none.
// Carries cumulative arc-length so a runner's participation reduces to a
// [enterKm, exitKm] interval, and provides arc → point / slice helpers.
//
// km 0 is the rendezvous: where the flock gathers and the flock clock starts.
// ---------------------------------------------------------------------------

import { bearingRad, despurLoop, destinationPoint, distanceMeters, pointToSegmentMeters } from "./geo";
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
// approach passes within this distance of it. Exported: the engine also uses it to
// require a dispersal-joiner's egress to genuinely START at the backbone end.
export const FORMATION_TOLERANCE_M = 35;
// Don't pull the rendezvous back for a shared tail shorter than this — a sub-600m
// merge isn't worth re-anchoring the flock (mirrors MIN_GROW_KM / MIN_EXTENSION_KM).
// Exported: the engine gates its Phase-B rebuild on the same threshold.
export const FORMATION_MIN_MERGE_KM = 0.6;
// Walking the tail back from the waypoint it must keep heading AWAY from it; a
// momentary fold back toward it (a switchback / one-way pair) up to this far is
// tolerated before we call it a divergence.
const FORMATION_MONOTONE_SLACK_M = 60;

// --- Stage 1: FORCED convergence (a computed meeting point off the runners' lines) ---
// When runners DON'T share a road into the waypoint (natural F can't fire), we can still
// bend them to MEET at a computed point P, then run P→waypoint together — paying a detour.
// Only worth attempting in a band of origin spreads: below this the bearings are
// near-collinear (natural F should have caught them), above it the road-detour discount
// collapses (the sim: forced bonus ~0.67 of Euclidean at 120°, worse beyond).
const FORCED_SPREAD_MIN_DEG = 20;
const FORCED_SPREAD_MAX_DEG = 150;

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

export interface DispersalPoint {
  dispPoint: LatLng; // D — where the flock splits on the way out (== backbone end when nothing fired)
  dispKm: number; // length of the shared end→D tail (0 ⇒ disparate finishes, leave the end)
  sharedFromEndToD: LatLng[]; // the shared corridor polyline end→D (≥2 pts when fired)
}

/**
 * The computed DISPERSAL POINT D — the egress-side MIRROR of F. The dispersal-joiners
 * (runners reaching the backbone END) run home along egress routes that start at the
 * end and share a corridor before splitting to their finishes; D is where they diverge.
 * The flock runs end→D together, then peels apart. Implemented by REVERSING each egress
 * (so it ends at the backbone end) and reusing computeFormationPoint's common-tail
 * search, then reversing the shared geometry back. Pure + ORS-free. When finishes are
 * disparate the shared tail is short and D collapses to the backbone end (dispKm 0).
 */
export function computeDispersalPoint(egressGeoms: LatLng[][], backboneEnd: LatLng): DispersalPoint {
  const reversed = egressGeoms.map((g) => [...g].reverse()); // finish→end (so each ends at backboneEnd)
  const F = computeFormationPoint(reversed, backboneEnd);
  if (F.forkKm < FORMATION_MIN_MERGE_KM) {
    return { dispPoint: backboneEnd, dispKm: 0, sharedFromEndToD: [] };
  }
  // F.sharedFromForkToWp0 is D→end (in the reversed order); reverse → end→D.
  return {
    dispPoint: F.forkPoint,
    dispKm: F.forkKm,
    sharedFromEndToD: [...F.sharedFromForkToWp0].reverse(),
  };
}

/**
 * Append the shared end→D tail to a backbone, so it ends at D and the flock runs the
 * shared egress corridor together before splitting. PURE (no ORS) — mirror of
 * prependFormationLead but at the BACK. Unlike the prepend, existing arc positions
 * (and stops) are UNCHANGED — the extension is past the old end — so stops are kept
 * verbatim (re-snapping could mis-bind them to the new geometry). The seam drops the
 * tail's first vertex (≈ the backbone's current last vertex, both the old end).
 */
export function appendDispersalLead(backbone: Backbone, sharedTail: LatLng[], dispPoint: LatLng): Backbone {
  if (sharedTail.length < 2) return backbone;
  const coords = [...backbone.coords, ...sharedTail.slice(1)];
  const { cumKm, totalKm } = withCum(coords);
  return {
    rendezvous: backbone.rendezvous,
    coords,
    cumKm,
    totalKm,
    stops: backbone.stops, // unchanged: the append is past every existing stop
    formationPoint: backbone.formationPoint,
    dispersalPoint: dispPoint,
  };
}

/** Largest angular gap (degrees) between any two bearings — the origin "spread". */
function bearingSpreadDeg(homes: LatLng[], wp0: LatLng): number {
  const degs = homes.map((h) => (bearingRad(h, wp0) * 180) / Math.PI);
  let max = 0;
  for (let i = 0; i < degs.length; i++)
    for (let j = i + 1; j < degs.length; j++) {
      const raw = Math.abs(degs[i] - degs[j]) % 360;
      max = Math.max(max, Math.min(raw, 360 - raw));
    }
  return max;
}

/**
 * The computed FORCED meeting point P — Stage 1's disparate-origin tier of F. When the
 * runners don't share a road into the waypoint (natural F can't fire), find a point P
 * to bend them to, off their shortest lines, so they run P→waypoint together. P is the
 * slack-bound optimum (the sim's best_meet, discretised): the FARTHEST-BACK point along
 * the centroid(homes)→waypoint funnel axis whose detour EVERY runner can afford. A 1-D
 * scan of a few candidates — never a 2-D grid, never ORS (crow estimates pick P; the
 * caller re-validates the winner with real ORS before committing).
 *
 * Returns null when the origins are too collinear or too splayed (the geometric gate),
 * the waypoint sits among the homes (nothing to share), or no candidate is affordable.
 *
 * @param homes      each candidate joiner's start
 * @param approachKm each joiner's natural home→waypoint distance (the no-merge baseline)
 * @param slackKm    each joiner's detour budget (km they can add under their hard cap)
 * @param roadFactor crow→road inflation, so the crow detour estimate isn't over-optimistic
 */
export function computeForcedMeetingPoint(
  homes: LatLng[],
  approachKm: number[],
  slackKm: number[],
  wp0: LatLng,
  roadFactor: number,
): LatLng | null {
  if (homes.length < 2) return null;
  const spread = bearingSpreadDeg(homes, wp0);
  if (spread < FORCED_SPREAD_MIN_DEG || spread > FORCED_SPREAD_MAX_DEG) return null;

  const c = centroid(homes);
  const axisKm = distanceMeters(c, wp0) / 1000;
  if (axisKm < MIN_GROW_KM) return null; // waypoint basically among the homes — nothing to share
  const dir = bearingRad(c, wp0);

  // Candidates spaced along the funnel axis. t→0 sits far back (more shared distance, but
  // bigger detours); t→1 hugs the waypoint. We keep the affordable candidate with the
  // MOST shared distance (farthest back), which is the kernel's argmax-feasible.
  let best: { P: LatLng; sharedKm: number } | null = null;
  for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const P = destinationPoint(c, dir, t * axisKm);
    const sharedKm = distanceMeters(P, wp0) / 1000; // run together P→waypoint
    const affordable = homes.every((h, i) => {
      const detour = roadFactor * (distanceMeters(h, P) / 1000 + sharedKm) - approachKm[i];
      return detour <= slackKm[i] + 1e-9;
    });
    if (affordable && (!best || sharedKm > best.sharedKm)) best = { P, sharedKm };
  }
  return best?.P ?? null;
}

// --- Stage: PEEL-AT-HOME rosette (AUTO mode) --------------------------------
// Build the auto backbone as NESTED return-to-base laps keyed on the constrained
// runners' reaches, instead of one far-flung lobe. The spine returns to the rendezvous
// at each reach, so a budget-limited runner finishes a WHOLE shared lap AT home rather
// than peeling on the far side and trudging back solo. Distinct seeds per lap send
// consecutive laps in DIFFERENT directions, so they don't share a spoke out of the root
// — a shared spoke is a zero-area fold that despurLoop would delete, collapsing the seam
// (the prototype's make-or-break finding). VALIDATED: if any lap's return-to-base didn't
// survive de-spur, return null and the caller falls back to the single lobe (degrade,
// never worse). ORS cost: one round-trip per lap (≈ the number of distinct reach tiers).
const ROSETTE_SEEDS = [1, 13, 29, 47, 71, 97, 131];
// A lap counts as returning home when it passes within this of the rendezvous.
const ROSETTE_RETURN_TOL_M = 120;
// De-spur shifts arc positions slightly; search this far either side of a breakpoint.
const ROSETTE_RETURN_WINDOW_KM = 2;

async function buildRosette(
  center: LatLng,
  targetKm: number,
  innerReaches: number[],
): Promise<Pick<Backbone, "coords" | "cumKm" | "totalKm"> | null> {
  const breaks = innerReaches.filter((r) => r > MIN_GROW_KM && r < targetKm - MIN_GROW_KM);
  if (breaks.length === 0) return null; // no inner peel point → plain lobe (today's behaviour)
  const ends = [...breaks, targetKm];
  const lapLens: number[] = [];
  let prev = 0;
  for (const e of ends) {
    lapLens.push(e - prev);
    prev = e;
  }
  if (lapLens.some((l) => l < MIN_GROW_KM)) return null; // a degenerate sliver lap — not worth it

  // One return-to-base round-trip per lap, each with a DISTINCT seed (different bearings),
  // concatenated at the rendezvous (drop the duplicate seam vertex).
  let coords: LatLng[] = [];
  try {
    for (let i = 0; i < lapLens.length; i++) {
      const lap = fromOrs(await getRoundTrip(center, lapLens[i], ROSETTE_SEEDS[i % ROSETTE_SEEDS.length]));
      coords = i === 0 ? lap.coords : coords.concat(lap.coords.slice(1));
    }
  } catch (err) {
    log.warn("rosette lap routing failed — falling back to single lobe", { error: String(err) });
    return null;
  }

  // De-spur the FULL concatenation: a seam fold (two laps sharing a spoke) surfaces here.
  const geom = withCum(despurLoop(coords).coords);

  // Validate every intended peel point still returns to base after de-spur; else bail so
  // we never ship a backbone that silently strands the runner it was shaped for.
  for (const e of breaks) {
    let nearM = Infinity;
    for (let i = 1; i < geom.coords.length - 1; i++) {
      if (Math.abs(geom.cumKm[i] - e) > ROSETTE_RETURN_WINDOW_KM) continue;
      const d = distanceMeters(geom.coords[i], center);
      if (d < nearM) nearM = d;
    }
    if (nearM > ROSETTE_RETURN_TOL_M) {
      log.warn("rosette return-to-base lost to de-spur — falling back to single lobe", {
        breakpointKm: Number(e.toFixed(2)),
        nearM: Math.round(nearM),
      });
      return null;
    }
  }

  log.info("rosette backbone built", {
    laps: lapLens.length,
    totalKm: Number(geom.totalKm.toFixed(2)),
    peelKm: breaks.map((b) => Number(b.toFixed(2))),
  });
  return geom;
}

export async function buildBackbone(opts: {
  waypoints: FlockWaypoint[];
  starts: LatLng[];
  targetKm: number;
  // Inner peel-at-home reaches (AUTO mode only): ascending, sub-targetKm runner reaches
  // the rosette returns to base at. Empty / absent ⇒ today's single lobe (unchanged).
  reaches?: number[];
}): Promise<Backbone> {
  const { waypoints, starts, targetKm, reaches = [] } = opts;

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
    // Auto / single-waypoint: a loop from the rendezvous sized to the target. For an AUTO
    // flock (no waypoint to pin) with a spread of budgets, shape that loop as a PEEL-AT-HOME
    // rosette — nested laps returning to the rendezvous at each constrained runner's reach —
    // so they finish a whole shared lap at home instead of peeling far out on one lobe.
    // Falls back to the single lobe when there's no inner tier, routing fails, or a lap's
    // return didn't survive de-spur, so the no-spread case is byte-identical. Single-waypoint
    // loops keep the plain lobe (forced F/D handle their convergence).
    rendezvous = waypoints.length === 1 ? waypoints[0].location : centroid(starts);
    const rosette =
      waypoints.length === 0 ? await buildRosette(rendezvous, Math.max(1, targetKm), reaches) : null;
    geom = rosette ?? fromOrs(await getRoundTrip(rendezvous, Math.max(1, targetKm)));
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
