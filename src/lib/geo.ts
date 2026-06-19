// ---------------------------------------------------------------------------
// Coordinate-order converters.
//
// ORS / GeoJSON use [longitude, latitude]. Leaflet uses [latitude, longitude].
// NEVER mix these up by hand — always go through these helpers.
// ---------------------------------------------------------------------------

import type { LatLng } from "./types";

/** Flock LatLng → ORS/GeoJSON [lng, lat]. */
export const toORS = (ll: LatLng): [number, number] => [ll.lng, ll.lat];

/** ORS/GeoJSON [lng, lat] → Flock LatLng. */
export const fromORS = (coord: [number, number]): LatLng => ({
  lat: coord[1],
  lng: coord[0],
});

/** Flock LatLng → Leaflet [lat, lng] tuple. */
export const toLeaflet = (ll: LatLng): [number, number] => [ll.lat, ll.lng];

/** Initial bearing from a → b, in radians. */
export function bearingRad(a: LatLng, b: LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

/** Point reached by travelling `distKm` from `from` along `bearing` (radians). */
export function destinationPoint(from: LatLng, bearing: number, distKm: number): LatLng {
  const R = 6371;
  const δ = distKm / R;
  const φ1 = (from.lat * Math.PI) / 180;
  const λ1 = (from.lng * Math.PI) / 180;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearing),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: (φ2 * 180) / Math.PI, lng: (λ2 * 180) / Math.PI };
}

/** Haversine distance between two points, in metres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// De-spur: trim contiguous "dead folds" (out-and-back spurs) from a loop.
//
// ORS round-trips are built from points scattered at random bearings, so they
// frequently run out to a point and retrace the SAME road back — visible
// doubling-back that wastes distance. A "dead fold" is a contiguous sub-path
// that leaves a vertex and returns to within ~ε of that SAME vertex while
// enclosing ~zero area (the out-and-back). We DELETE such sub-paths.
//
// SAFETY INVARIANT: because the cut's two ends coincide (within ε), the result
// is a strict subset of the real ORS geometry — we only remove edges, never
// fabricate a connecting line. So the cleaned loop stays a faithful on-road
// route. This is the whole reason de-spur is safe; preserve it.
//
// What survives untouched (by construction, not by luck):
//   • a genuine sub-loop / block-loop (encloses real area → fails the width test)
//   • a cul-de-sac ACCESS corridor (start→corridor→loop→corridor→start): the two
//     corridor traversals are non-contiguous (the loop sits between them), so they
//     never form a contiguous fold; the only revisit is the loop closure (huge area)
//   • a figure-eight crossing (each lobe encloses real area)
// A genuine dead-end-tip excursion IS trimmed — that is the waste we want gone;
// only the access corridor must be preserved, and it is.
// ---------------------------------------------------------------------------

// Two vertices within this distance (m) are treated as the SAME point — the
// "revisit" radius bounding a candidate fold.
const DESPUR_EPSILON_M = 30;
// A fold's two ends must be at least this far apart ALONG the path (m), so we
// skip immediate neighbours and the loop's own start↔end closure.
const DESPUR_BACK_GAP_M = 150;
// Mean width = enclosed area / perimeter, in metres. An out-and-back retrace is
// ~0 (the two legs are coincident); a real block-loop is tens of metres. Below
// this the fold encloses ~no area and is treated as dead.
const DESPUR_WIDTH_THRESH_M = 25;
// Safety cap on de-spur passes (each pass removes exactly one fold; folds are few).
const DESPUR_MAX_PASSES = 24;

interface MetricXY {
  x: number;
  y: number;
}

/** Project to a local metric plane via a single-lat0 equirectangular map, so
 *  vertex distances, grid cells and shoelace areas are all in metres. */
function projectMetric(coords: LatLng[]): MetricXY[] {
  const kx = Math.cos((coords[0].lat * Math.PI) / 180) * 111320; // m per ° lng at lat0
  const ky = 110540; // m per ° lat
  return coords.map((c) => ({ x: c.lng * kx, y: c.lat * ky }));
}

/** Shoelace area (m², absolute) of the closed ring xy[i..j] (closing j → i). */
function ringAreaM2(xy: MetricXY[], i: number, j: number): number {
  let a = 0;
  for (let k = i; k <= j; k++) {
    const cur = xy[k];
    const nxt = k === j ? xy[i] : xy[k + 1];
    a += cur.x * nxt.y - nxt.x * cur.y;
  }
  return Math.abs(a) / 2;
}

/** Remove the first (outermost) dead fold found scanning left→right; returns the
 *  trimmed coords, or null if there is no dead fold left to remove. */
function despurOnce(coords: LatLng[]): LatLng[] | null {
  const n = coords.length;
  if (n < 4) return null;

  // Cumulative arc-length (m) — also serves as a fold's perimeter (the closing
  // edge i→j is ≤ε, negligible).
  const s = new Array<number>(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + distanceMeters(coords[i - 1], coords[i]);

  const xy = projectMetric(coords);
  const cell = DESPUR_EPSILON_M;
  const key = (gx: number, gy: number) => `${gx}:${gy}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(xy[i].x / cell), Math.floor(xy[i].y / cell));
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  }

  for (let i = 0; i < n; i++) {
    const gx = Math.floor(xy[i].x / cell);
    const gy = Math.floor(xy[i].y / cell);
    const cands: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(key(gx + dx, gy + dy));
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          if (i === 0 && j === n - 1) continue; // never collapse the loop closure
          if (s[j] - s[i] <= DESPUR_BACK_GAP_M) continue;
          if (distanceMeters(coords[i], coords[j]) > DESPUR_EPSILON_M) continue;
          cands.push(j);
        }
      }
    }
    if (cands.length === 0) continue;
    // Largest j first → take the OUTERMOST dead fold at this i (subsumes nested ones).
    cands.sort((a, b) => b - a);
    for (const j of cands) {
      const perim = s[j] - s[i];
      if (perim <= 0) continue;
      const width = ringAreaM2(xy, i, j) / perim;
      if (width < DESPUR_WIDTH_THRESH_M) {
        // Dead fold: keep coords[i], drop i+1..j, resume at coords[j+1]. The new
        // seam edge coords[i]→coords[j+1] ≈ the real edge coords[j]→coords[j+1]
        // (since coords[i] ≈ coords[j] within ε).
        return coords.slice(0, i + 1).concat(coords.slice(j + 1));
      }
    }
  }
  return null;
}

/**
 * Trim dead out-and-back folds from a loop's vertices. Idempotent (a second run
 * is a no-op) and deterministic (pure geometry). Returns the cleaned coords and
 * their recomputed length in km.
 */
export function despurLoop(input: LatLng[]): { coords: LatLng[]; distanceKm: number } {
  let coords = input;
  for (let pass = 0; pass < DESPUR_MAX_PASSES; pass++) {
    const next = despurOnce(coords);
    if (!next) break;
    coords = next;
  }
  let meters = 0;
  for (let k = 1; k < coords.length; k++) meters += distanceMeters(coords[k - 1], coords[k]);
  return { coords, distanceKm: meters / 1000 };
}
