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
