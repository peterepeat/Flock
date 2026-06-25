// Shared harness for the social-first engine test suites (_st_*.ts). Installs a
// DETERMINISTIC fake-ORS (straight-line p2p, clean square round-trips) so calculateRoutes
// is reproducible, and exports new-model builders + a tiny assert runner. Each suite:
//   import { calculateRoutes, person, wp, session, ok, finish, ... } from "./_st_harness";
//   ... build sessions, call calculateRoutes, ok(...) ...
//   finish();
//
// fake-ORS is installed at module load (before any engine call); the engine reads fetch
// only at call time, so import order is safe.

// --- deterministic fake ORS ---
const R = 6371000;
function hav(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180, dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function orsResp(coords: [number, number][], km: number): Response {
  return new Response(
    JSON.stringify({ features: [{ geometry: { type: "LineString", coordinates: coords }, properties: { summary: { distance: km, duration: km * 600 } } }] }),
    { status: 200, headers: { "content-type": "application/geo+json", "x-ratelimit-remaining": "1000" } },
  );
}
globalThis.fetch = (async (_u: string, opts: { body: string }) => {
  const body = JSON.parse(opts.body) as { coordinates: [number, number][]; options?: { round_trip?: { length: number } } };
  const rt = body.options?.round_trip;
  if (rt) {
    const [lng, lat] = body.coordinates[0], side = rt.length / 4, dLat = side / 111320, dLng = side / (111320 * Math.cos((lat * Math.PI) / 180));
    return orsResp([[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]], rt.length / 1000);
  }
  let m = 0;
  for (let i = 1; i < body.coordinates.length; i++) m += hav(body.coordinates[i - 1], body.coordinates[i]);
  return orsResp(body.coordinates, m / 1000);
}) as unknown as typeof fetch;
process.env.ORS_API_KEY ??= "fake";
process.env.FLOCK_LOG_LEVEL ??= "error";

import type { FlockSession, FlockWaypoint, LocationPin, Participant, TimeAnchor } from "../src/lib/types";

export { calculateRoutes } from "../src/lib/flock";
export { planRun } from "../src/lib/flock/plan";
export { buildRoute } from "../src/lib/flock/route";
export type { FlockCalcResult } from "../src/lib/flock/project";
export type { FlockSession, Participant, FlockWaypoint, LocationPin, TimeAnchor };

// --- pins ---
export const auto: LocationPin = { kind: "auto" };
export const atWp = (waypointId: string): LocationPin => ({ kind: "waypoint", waypointId });
export const atPlace = (lat: number, lng: number, address = "pin"): LocationPin => ({ kind: "manual", location: { lat, lng }, address });

// --- builders (new social-first model) ---
export function person(id: string, opts: Partial<Participant> = {}): Participant {
  return { id, name: id, color: "#000", addedAt: "2026-01-01T00:00:00Z", startPin: auto, finishPin: auto, maxDistanceKm: null, pace: null, earliestStartTime: null, latestFinishTime: null, ...opts };
}
export function wp(id: string, lat: number, lng: number, stopMinutes = 0): FlockWaypoint {
  return { id, location: { lat, lng }, address: id, name: id, stopMinutes };
}
export function session(participants: Participant[], waypoints: FlockWaypoint[] = [], opts: Partial<FlockSession> = {}): FlockSession {
  return {
    id: "t", createdAt: "", updatedAt: "", locks: { run: false, route: false, runners: false }, runnerLocks: {}, unitPreference: "km",
    startAnchor: { kind: "auto" }, intendedDistanceKm: null,
    participants, waypoints, computedRoutes: null, sharedSegments: null, flockRoute: null, waypointEtas: null, routeWarnings: null, gpxPassthrough: null,
    ...opts,
  };
}

// --- assert runner ---
let _pass = 0;
const _fails: string[] = [];
let _suite = "";
export function suite(name: string): void { _suite = name; console.log(`\n══ ${name} ══`); }
export function section(name: string): void { console.log(`\n— ${name} —`); }
export function ok(cond: boolean, msg: string): void {
  if (cond) { _pass++; console.log(`  ✓ ${msg}`); }
  else { _fails.push(`[${_suite}] ${msg}`); console.log(`  ✗ FAIL  ${msg}`); }
}
/** Assert without throwing on engine errors — captures a throw as a failure. */
export async function tryOk(fn: () => Promise<void> | void, label: string): Promise<void> {
  try { await fn(); } catch (e) { ok(false, `${label} — THREW: ${e instanceof Error ? e.message : String(e)}`); }
}
export function finish(): void {
  console.log(`\n${_fails.length === 0 ? "✅ ALL PASS" : `❌ ${_fails.length} FAILED`}  (${_pass}/${_pass + _fails.length})`);
  if (_fails.length) { console.log("FAILURES:"); for (const f of _fails) console.log("  · " + f); }
  process.exit(_fails.length ? 1 : 0);
}

// --- handy helpers for assertions ---
export const lineKm = (coords: number[][]): number => {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += hav(coords[i - 1] as [number, number], coords[i] as [number, number]);
  return m / 1000;
};
