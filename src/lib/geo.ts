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
