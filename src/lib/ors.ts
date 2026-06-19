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

import { despurLoop, fromORS, toORS } from "./geo";
import { createLogger } from "./logger";
import type { LatLng } from "./types";

const log = createLogger("ors");

const ORS_BASE = "https://api.openrouteservice.org/v2/directions/foot-hiking/geojson";
const MAX_RETRIES = 2;

// ORS round-trips wander out-and-back; de-spur (despurLoop) trims those dead
// folds, which SHORTENS the loop. So we over-request by this fraction to still
// land near the asked length. The post-trim length is approximate — callers that
// need a hard length already truncate/scale it (truncateToKm, fitLoop) — so this
// is a tuning knob, not a correctness dependency.
const DESPUR_OVERREQUEST = 0.15;

export type RouteErrorCode =
  | "no-key"
  | "no-route"
  | "rate-limited" // transient per-minute burst — retryable
  | "quota-exhausted" // daily quota spent — won't recover until resetAt
  | "ors-error"
  | "network";

export class RouteError extends Error {
  constructor(
    public code: RouteErrorCode,
    message: string,
    public status?: number,
    public resetAt?: number, // epoch seconds the daily quota resets (quota-exhausted only)
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
 *
 * ORS builds round-trips from RANDOM bearings keyed by `seed`, so for a given
 * point + length one seed can fail to close the loop ("2009 — unable to find a
 * route for point") while another succeeds. We retry a handful of seeds on that
 * specific no-route failure (rate-limit / network errors propagate immediately,
 * so we don't burn the per-minute budget).
 */
export async function getRoundTrip(start: LatLng, lengthKm: number, seed = 1): Promise<OrsRoute> {
  const coordinates = [toORS(start)];
  const seeds = [seed, seed + 1, seed + 3, seed + 7, seed + 17];
  const requestedKm = lengthKm * (1 + DESPUR_OVERREQUEST);
  let lastErr: RouteError | null = null;
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    try {
      const raw = await call(
        { coordinates, roundTrip: { lengthMeters: Math.round(requestedKm * 1000), seed: s, points: 4 } },
        { kind: "loop", lengthKm, requestedKm: Number(requestedKm.toFixed(2)), seed: s, seedAttempt: i },
      );
      return despur(raw);
    } catch (err) {
      if (err instanceof RouteError && err.code === "no-route") {
        lastErr = err; // unlucky seed — try the next one
        continue;
      }
      throw err; // rate-limit / network / config — don't waste more seeds
    }
  }
  log.warn("round-trip failed for every seed", { lengthKm, seeds: seeds.length });
  throw lastErr ?? new RouteError("no-route", "No round-trip route found");
}

/**
 * Trim dead out-and-back folds from a round-trip's geometry. Returns a new
 * OrsRoute with cleaned geometry + recomputed distance; orsDurationSec is scaled
 * by the length ratio (the engine recomputes timing from pace and never reads it,
 * but we keep it consistent for diagnostics).
 */
function despur(route: OrsRoute): OrsRoute {
  const raw = (route.geometry.coordinates as [number, number][]).map(fromORS);
  const { coords, distanceKm } = despurLoop(raw);
  if (coords.length === raw.length) return route; // nothing trimmed
  const ratio = route.distanceKm > 0 ? distanceKm / route.distanceKm : 1;
  log.info("de-spurred round-trip", {
    fromKm: Number(route.distanceKm.toFixed(2)),
    toKm: Number(distanceKm.toFixed(2)),
    fromPts: raw.length,
    toPts: coords.length,
  });
  return {
    geometry: { type: "LineString", coordinates: coords.map(toORS) },
    distanceKm,
    orsDurationSec: route.orsDurationSec * ratio,
  };
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
        // ORS returns 429 for BOTH the per-minute burst limit and the daily
        // quota. x-ratelimit-* tracks the DAILY budget, so remaining "0" means
        // the daily quota is spent (won't recover until reset) — distinct from a
        // transient burst, which we back off + retry.
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        if (remaining === "0") {
          log.warn("ORS daily quota exhausted", { reset, ...meta });
          lastErr = new RouteError(
            "quota-exhausted",
            "Daily routing limit reached",
            429,
            Number.isFinite(reset) ? reset : undefined,
          );
          break; // retrying won't help until the quota resets
        }
        const backoff = 500 * 2 ** attempt;
        log.warn("ORS rate-limited", { attempt, backoff, remaining, ...meta });
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
