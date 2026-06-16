// ---------------------------------------------------------------------------
// OpenRouteService client (server-only).
//
// Uses the foot-hiking profile (follows trails/footpaths faithfully). Supports
// point-to-point routing through ordered waypoints and round-trip loop routing.
// Coordinates are ALWAYS [lng, lat] (ORS/GeoJSON order) — callers pass LatLng
// and we convert via geo.toORS.
//
// Heavy diagnostics: every call logs the request shape, ORS status, distance,
// duration and elapsed time, plus retry/backoff decisions. This is the layer
// most likely to fail (rate limits, no-route), so it is instrumented closely.
// ---------------------------------------------------------------------------

import { toORS } from "./geo";
import { createLogger } from "./logger";
import type { LatLng } from "./types";

const log = createLogger("ors");

const ORS_BASE = "https://api.openrouteservice.org/v2/directions/foot-hiking/geojson";
const MAX_RETRIES = 2;

export type RouteErrorCode = "no-key" | "no-route" | "rate-limited" | "ors-error" | "network";

export class RouteError extends Error {
  constructor(
    public code: RouteErrorCode,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

export interface OrsRoute {
  geometry: GeoJSON.LineString; // [lng, lat][]
  distanceKm: number;
  orsDurationSec: number;
}

interface RoundTripOpts {
  lengthMeters: number;
  seed?: number;
  points?: number;
}

function apiKey(): string {
  const key = process.env.ORS_API_KEY;
  if (!key) {
    throw new RouteError("no-key", "ORS_API_KEY is not set");
  }
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Point-to-point route through the given ordered waypoints (≥2).
 */
export async function getRoute(waypoints: LatLng[]): Promise<OrsRoute> {
  if (waypoints.length < 2) {
    throw new RouteError("ors-error", "Need at least 2 waypoints for a route");
  }
  const coordinates = waypoints.map(toORS);
  return call({ coordinates }, { kind: "p2p", waypoints: waypoints.length });
}

/**
 * Round-trip loop route starting and ending at `start`, ~lengthKm long.
 */
export async function getRoundTrip(start: LatLng, lengthKm: number, seed = 1): Promise<OrsRoute> {
  const coordinates = [toORS(start)];
  const roundTrip: RoundTripOpts = {
    lengthMeters: Math.round(lengthKm * 1000),
    seed,
    points: 4,
  };
  return call({ coordinates, roundTrip }, { kind: "loop", lengthKm });
}

interface CallBody {
  coordinates: [number, number][];
  roundTrip?: RoundTripOpts;
}

async function call(body: CallBody, meta: Record<string, unknown>): Promise<OrsRoute> {
  // Nudge toward nicer running: skip stairs and ferries. (The public ORS
  // foot-hiking profile already favours paths/trails; there is no "green"
  // preference on the standard API, so this is the available lever.)
  const options: Record<string, unknown> = { avoid_features: ["steps", "ferries"] };
  if (body.roundTrip) {
    options.round_trip = {
      length: body.roundTrip.lengthMeters,
      points: body.roundTrip.points ?? 4,
      seed: body.roundTrip.seed ?? 1,
    };
  }

  const payload: Record<string, unknown> = {
    coordinates: body.coordinates,
    preference: "recommended",
    units: "km",
    instructions: false,
    elevation: false,
    options,
  };

  const done = log.time("directions", meta);
  let lastErr: RouteError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(ORS_BASE, {
        method: "POST",
        headers: {
          Authorization: apiKey(),
          "Content-Type": "application/json",
          Accept: "application/geo+json",
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        const backoff = 500 * 2 ** attempt;
        log.warn("ORS rate-limited", { attempt, backoff, ...meta });
        lastErr = new RouteError("rate-limited", "ORS rate limit", 429);
        if (attempt < MAX_RETRIES) {
          await sleep(backoff);
          continue;
        }
        break;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // ORS uses 2009/2010 error codes for "no route found".
        const isNoRoute = res.status === 404 || /2009|2010|could not find/i.test(text);
        log.warn("ORS error response", { status: res.status, isNoRoute, body: text.slice(0, 240), ...meta });
        lastErr = new RouteError(
          isNoRoute ? "no-route" : "ors-error",
          isNoRoute ? "No runnable route found" : `ORS error ${res.status}`,
          res.status,
        );
        if (!isNoRoute && res.status >= 500 && attempt < MAX_RETRIES) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        break;
      }

      const json = (await res.json()) as {
        features?: { geometry: GeoJSON.LineString; properties?: { summary?: { distance?: number; duration?: number } } }[];
      };
      const feature = json.features?.[0];
      if (!feature?.geometry?.coordinates?.length) {
        log.warn("ORS returned empty geometry", meta);
        lastErr = new RouteError("no-route", "No runnable route found");
        break;
      }

      const summary = feature.properties?.summary ?? {};
      const distanceKm = summary.distance ?? 0;
      const orsDurationSec = summary.duration ?? 0;
      done({
        ok: true,
        points: feature.geometry.coordinates.length,
        distanceKm: Number(distanceKm.toFixed(2)),
        orsDurationMin: Number((orsDurationSec / 60).toFixed(1)),
      });
      return { geometry: feature.geometry, distanceKm, orsDurationSec };
    } catch (err) {
      if (err instanceof RouteError) {
        lastErr = err;
        break; // config errors (no-key) shouldn't be retried
      }
      log.error("ORS network error", { attempt, error: String(err), ...meta });
      lastErr = new RouteError("network", "Could not reach the routing service");
      if (attempt < MAX_RETRIES) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
    }
  }

  done({ ok: false, code: lastErr?.code });
  throw lastErr ?? new RouteError("ors-error", "Unknown routing error");
}
