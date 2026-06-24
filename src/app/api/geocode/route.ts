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

// Min half-extent (deg) of the local search box, so even a zoomed-in view still
// searches the surrounding metro area rather than just the streets on screen
// (~0.25° ≈ 25–28 km half-extent → a ~55 km box).
const LOCAL_MIN_HALF_DEG = 0.25;
// At or above this many in-view hits we trust the local box alone; below it we ALSO
// run an unconstrained query and append the rest, so a clearly-distant address the
// user fully types still surfaces.
const MIN_LOCAL_RESULTS = 4;
const LIMIT = 6;

/** A Photon bbox (minLon,minLat,maxLon,maxLat) around `focus`, at least
 *  LOCAL_MIN_HALF_DEG but never tighter than the current view. */
function localBbox(focus: LatLng, viewbox: string | null): string {
  let halfLat = LOCAL_MIN_HALF_DEG;
  let halfLng = LOCAL_MIN_HALF_DEG;
  if (viewbox) {
    const [mnLng, mnLat, mxLng, mxLat] = viewbox.split(",").map(Number);
    if ([mnLng, mnLat, mxLng, mxLat].every((n) => Number.isFinite(n))) {
      halfLat = Math.max(halfLat, Math.abs(mxLat - mnLat) / 2);
      halfLng = Math.max(halfLng, Math.abs(mxLng - mnLng) / 2);
    }
  }
  return `${focus.lng - halfLng},${focus.lat - halfLat},${focus.lng + halfLng},${focus.lat + halfLat}`;
}

/** Append `extra` after `primary`, de-duping by rounded coordinate, capped at `limit`. */
function mergeDedupe(primary: GeocodeResult[], extra: GeocodeResult[], limit: number): GeocodeResult[] {
  const key = (r: GeocodeResult) => `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`;
  const seen = new Set(primary.map(key));
  const out = [...primary];
  for (const r of extra) {
    if (out.length >= limit) break;
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    out.push(r);
  }
  return out.slice(0, limit);
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

  // Constrain to the current view (the only proximity lever Photon honours — see
  // photonSearch). The cache key carries a coarse bbox so a wide-view and a
  // zoomed-in search at the same centre don't share an entry.
  const bbox = focus ? localBbox(focus, viewbox) : null;
  const bboxKey = bbox ? bbox.split(",").map((n) => Number(n).toFixed(2)).join(",") : "global";
  const cacheKey = `${q.toLowerCase()}|${bboxKey}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    done({ count: cached.length, cached: true });
    return NextResponse.json({ results: cached });
  }

  // Primary: Photon. Search the local box first; only when it's sparse do we ALSO
  // run an unconstrained query and append the rest (local-first, distant reachable).
  try {
    let results = await photonSearch(q, { focus, bbox, limit: LIMIT });
    if (bbox && results.length < MIN_LOCAL_RESULTS) {
      try {
        const global = await photonSearch(q, { focus, limit: LIMIT });
        results = mergeDedupe(results, global, LIMIT);
      } catch {
        /* keep whatever the local box gave us */
      }
    }
    cacheSet(cacheKey, results);
    done({ count: results.length, provider: "photon", bounded: !!bbox });
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
