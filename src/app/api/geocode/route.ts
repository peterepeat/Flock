import { NextResponse } from "next/server";

import { createLogger } from "@/lib/logger";
import { photonSearch } from "@/lib/photon";
import type { GeocodeResult, LatLng } from "@/lib/types";

const log = createLogger("api:geocode");

export const dynamic = "force-dynamic";

// Photon (komoot) is the PRIMARY autocomplete backend — it's built for type-ahead
// and biases to a focus point. Public Nominatim is the FALLBACK only (it forbids
// autocomplete + caps 1 req/sec), still requiring a descriptive User-Agent.
const USER_AGENT = "Flock/1.0 (peter@haasz.com.au)";

// Tiny in-memory cache: identical query+view within the TTL skips the upstream
// call (cuts latency on backspace/retype; reduces load). Per warm server instance.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; results: GeocodeResult[] }>();

function cacheGet(key: string): GeocodeResult[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // refresh LRU recency
  cache.delete(key);
  cache.set(key, hit);
  return hit.results;
}

function cacheSet(key: string, results: GeocodeResult[]) {
  cache.set(key, { at: Date.now(), results });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
}

/** Fallback path: public Nominatim, softly biased to the current view via viewbox
 *  (NOT bounded, so distant matches still appear). */
async function nominatimSearch(q: string, viewbox: string | null): Promise<GeocodeResult[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("limit", "6");
  if (viewbox) url.searchParams.set("viewbox", viewbox); // minLon,minLat,maxLon,maxLat

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const raw = (await res.json()) as NominatimResult[];
  return raw.map((r) => ({
    displayName: r.display_name,
    shortName: r.display_name.split(",").slice(0, 2).join(",").trim(),
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}

function parseFocus(searchParams: URLSearchParams): LatLng | null {
  const lat = parseFloat(searchParams.get("lat") || "");
  const lng = parseFloat(searchParams.get("lng") || "");
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  const focus = parseFocus(searchParams);
  const viewbox = searchParams.get("viewbox"); // for the Nominatim fallback
  const done = log.time("geocode", { q, focused: !!focus });

  if (q.length < 3) {
    done({ skipped: true });
    return NextResponse.json({ results: [] });
  }

  const cacheKey = `${q.toLowerCase()}|${focus ? `${focus.lat.toFixed(2)},${focus.lng.toFixed(2)}` : ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    done({ count: cached.length, cached: true });
    return NextResponse.json({ results: cached });
  }

  // Primary: Photon (type-ahead, focus-biased).
  try {
    const results = await photonSearch(q, { focus });
    cacheSet(cacheKey, results);
    done({ count: results.length, provider: "photon" });
    return NextResponse.json({ results });
  } catch (err) {
    log.warn("photon failed — falling back to nominatim", { q, error: String(err) });
  }

  // Fallback: Nominatim.
  try {
    const results = await nominatimSearch(q, viewbox);
    cacheSet(cacheKey, results);
    done({ count: results.length, provider: "nominatim" });
    return NextResponse.json({ results });
  } catch (err) {
    log.error("geocode failed (both providers)", { q, error: String(err) });
    done({ error: true });
    return NextResponse.json({ results: [], error: "search-unavailable" }, { status: 502 });
  }
}
