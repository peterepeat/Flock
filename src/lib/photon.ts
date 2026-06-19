// ---------------------------------------------------------------------------
// Photon geocoder client (server-only).
//
// Photon (https://photon.komoot.io) is an OSM-based geocoder PURPOSE-BUILT for
// "search as you type" — unlike public Nominatim, which forbids autocomplete and
// caps at 1 req/sec. So Photon backs the interactive address autocomplete and the
// reverse-on-tap naming; Nominatim stays as a fallback (see /api/geocode).
//
// Forward:  GET /api?q=<text>&limit=&lang=[&lat=&lon=]   (lat/lon = soft proximity focus)
// Reverse:  GET /reverse?lat=&lon=&lang=[&limit=]        (nearest indexed OSM objects)
//
// Coordinates in Photon GeoJSON are [lng, lat] (GeoJSON order); we convert to
// Flock's LatLng on the way out. Heavy diagnostics via the shared logger.
// ---------------------------------------------------------------------------

import { distanceMeters } from "./geo";
import { createLogger } from "./logger";
import type { GeocodeResult, LatLng } from "./types";

const log = createLogger("photon");

const PHOTON_BASE = "https://photon.komoot.io";
// Polite descriptive UA (Photon has no key; this identifies us if usage is reviewed).
const USER_AGENT = "Flock/1.0 (peter@haasz.com.au)";
// Don't let a slow/hung Photon stall the request — bail and let the caller fall back.
const TIMEOUT_MS = 4000;

// OSM top-level keys that denote a named point-of-interest (vs a bare address or
// admin boundary). Used to prefer "Edinburgh Gardens" over "12 Brunswick St" when
// naming a tapped pin.
const POI_KEYS = new Set([
  "amenity",
  "shop",
  "leisure",
  "tourism",
  "sport",
  "historic",
  "building",
  "office",
  "craft",
  "railway",
  "public_transport",
  "natural",
]);

interface PhotonProps {
  name?: string;
  housenumber?: string;
  street?: string;
  postcode?: string;
  city?: string;
  district?: string;
  locality?: string;
  county?: string;
  state?: string;
  country?: string;
  osm_key?: string;
  osm_value?: string;
  type?: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] }; // [lng, lat]
  properties: PhotonProps;
}

/** A reverse-geocode candidate: a nearby OSM object with a computed distance. */
export interface PhotonPlace {
  name: string | null; // the object's own name, if it has one (a POI/place)
  label: string; // best human label (name, else street address)
  shortName: string; // label + locality, for display
  isPoi: boolean; // named AND a point-of-interest-ish OSM key
  lat: number;
  lng: number;
  distanceM: number; // metres from the queried point
}

/** Build display labels from a Photon feature's address-ish properties. */
function labels(p: PhotonProps): { primary: string; shortName: string; displayName: string } {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ").trim();
  const primary = p.name || street || p.locality || p.district || p.city || p.state || p.country || "Unknown place";
  // De-dupe context parts and drop any that just repeat the primary.
  const context = Array.from(
    new Set([street, p.district, p.locality, p.city, p.state, p.country].filter((c): c is string => !!c)),
  ).filter((c) => c !== primary);
  const shortName = [primary, context[0]].filter(Boolean).join(", ");
  const displayName = [primary, ...context].join(", ");
  return { primary, shortName, displayName };
}

async function fetchPhoton(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<PhotonFeature[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // Abort if either the caller's signal or our timeout fires.
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const url = `${PHOTON_BASE}${path}?${params.toString()}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal });
    if (!res.ok) {
      log.warn("photon error", { path, status: res.status });
      throw new Error(`photon ${res.status}`);
    }
    const json = (await res.json()) as { features?: PhotonFeature[] };
    return json.features ?? [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Forward autocomplete. `focus` (the current map centre) softly biases results
 * toward that point — local matches rank first, but distant ones still appear.
 */
export async function photonSearch(
  q: string,
  opts: { focus?: LatLng | null; limit?: number; lang?: string; signal?: AbortSignal } = {},
): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({ q, limit: String(opts.limit ?? 6), lang: opts.lang ?? "en" });
  if (opts.focus) {
    params.set("lat", String(opts.focus.lat));
    params.set("lon", String(opts.focus.lng));
  }
  const done = log.time("photon-search", { q, focused: !!opts.focus });
  const features = await fetchPhoton("/api", params, opts.signal);
  const results: GeocodeResult[] = features.map((f) => {
    const { shortName, displayName } = labels(f.properties);
    const [lng, lat] = f.geometry.coordinates;
    return { displayName, shortName, lat, lng };
  });
  done({ count: results.length });
  return results;
}

/**
 * Reverse lookup near a point, nearest-first, each annotated with its distance
 * and whether it's a named POI. The caller decides whether a POI is close enough
 * to name the pin (the "within N metres" rule lives in /api/reverse-geocode).
 */
export async function photonReverse(
  point: LatLng,
  opts: { limit?: number; lang?: string; signal?: AbortSignal } = {},
): Promise<PhotonPlace[]> {
  const params = new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lng),
    limit: String(opts.limit ?? 8),
    lang: opts.lang ?? "en",
  });
  const done = log.time("photon-reverse", { lat: point.lat, lng: point.lng });
  const features = await fetchPhoton("/reverse", params, opts.signal);
  const places: PhotonPlace[] = features
    .map((f) => {
      const p = f.properties;
      const { primary, shortName } = labels(p);
      const [lng, lat] = f.geometry.coordinates;
      const hasName = !!p.name;
      return {
        name: hasName ? p.name! : null,
        label: primary,
        shortName,
        isPoi: hasName && !!p.osm_key && POI_KEYS.has(p.osm_key),
        lat,
        lng,
        distanceM: distanceMeters(point, { lat, lng }),
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
  done({ count: places.length, nearestM: places[0] ? Math.round(places[0].distanceM) : null });
  return places;
}
