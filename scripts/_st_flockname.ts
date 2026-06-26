// Auto flock-name derivation (pure, OUTPUT-only). Locks the illustrative examples + graceful degradation.
//   npx tsx scripts/_st_flockname.ts

import { deriveFlockName, flockDisplayName } from "../src/lib/flockName";
import type { ComputedRoute, FlockSession, FlockWaypoint } from "../src/lib/types";
import { ok, suite, section, finish } from "./_st_harness";

const wp = (name: string, lat: number, lng: number, autoNamed = false): FlockWaypoint =>
  ({ id: name, location: { lat, lng }, address: name, name, stopMinutes: 0, autoNamed });

const dep = (departureTime: string): ComputedRoute =>
  ({ participantId: departureTime, geometry: { type: "LineString", coordinates: [] }, schedule: [], departureTime, arrivalTime: departureTime, distanceKm: 1 }) as unknown as ComputedRoute;

const lineStr = (coords: number[][]): GeoJSON.LineString => ({ type: "LineString", coordinates: coords });

function mk(opts: Partial<FlockSession>): FlockSession {
  return {
    id: "t", createdAt: "", updatedAt: "", locks: { run: false, route: false, runners: false }, runnerLocks: {},
    unitPreference: "km", startAnchor: { kind: "auto" }, intendedDistanceKm: null, name: null,
    participants: [], waypoints: [], computedRoutes: null, sharedSegments: null, flockRoute: null,
    waypointEtas: null, routeWarnings: null, gpxPassthrough: null, ...opts,
  } as FlockSession;
}

// Real-ish Melbourne coords.
const FED = { lat: -37.818, lng: 144.9691 }; // Federation Square
const NGV = { lat: -37.8226, lng: 144.9689 }; // National Gallery of Victoria
const BAK = { lat: -37.8025, lng: 145.0035 }; // Convent Bakery
const FAR = { lat: -37.79, lng: 145.084 }; // a point ~10km east

const pointToPoint = lineStr([[144.99, -37.8], [145.05, -37.79]]); // start ≠ end
const loopAt = (p: { lat: number; lng: number }): GeoJSON.LineString =>
  lineStr([[p.lng, p.lat], [p.lng + 0.02, p.lat + 0.01], [p.lng + 0.01, p.lat - 0.01], [p.lng, p.lat]]); // start ≈ end

function main() {
  suite("flockname");

  section("the illustrative examples");
  ok(deriveFlockName(mk({ computedRoutes: [dep("07:00")], flockRoute: pointToPoint })) === "7am run",
    `time only → "7am run"`);
  ok(deriveFlockName(mk({ computedRoutes: [dep("07:30")], waypoints: [wp("Federation Square", FED.lat, FED.lng)], flockRoute: loopAt(FED) })) === "7:30am loop from Federation Square",
    `loop + origin waypoint → "7:30am loop from Federation Square"`);
  ok(deriveFlockName(mk({ computedRoutes: [dep("08:30")], waypoints: [wp("National Gallery of Victoria", NGV.lat, NGV.lng)], flockRoute: pointToPoint })) === "8:30am run to National Gallery of Victoria",
    `dest waypoint → "8:30am run to National Gallery of Victoria"`);
  ok(deriveFlockName(mk({ computedRoutes: [dep("09:30")], waypoints: [wp("Convent Bakery", BAK.lat, BAK.lng), wp("National Gallery of Victoria", NGV.lat, NGV.lng)], flockRoute: pointToPoint })) === "9:30am run to National Gallery of Victoria via Convent Bakery",
    `dest + 1 via → "…run to National Gallery of Victoria via Convent Bakery"`);

  section("shape discrimination");
  // A loop whose only waypoint sits FAR from the start is a destination (out-and-back), not an origin.
  ok(deriveFlockName(mk({ computedRoutes: [dep("07:00")], waypoints: [wp("National Gallery of Victoria", FAR.lat, FAR.lng)], flockRoute: loopAt({ lat: -37.8, lng: 144.99 }) })) === "7am run to National Gallery of Victoria",
    `loop geometry but FAR waypoint → "run to …" (not "loop from …")`);
  // Loop from an origin, with a further stop along the way.
  ok(deriveFlockName(mk({ computedRoutes: [dep("06:00")], waypoints: [wp("Federation Square", FED.lat, FED.lng), wp("Convent Bakery", BAK.lat, BAK.lng)], flockRoute: loopAt(FED) })) === "6am loop from Federation Square via Convent Bakery",
    `loop from origin + via stop`);
  // 3+ vias collapse to "& N more".
  ok(deriveFlockName(mk({ computedRoutes: [dep("07:00")], waypoints: [wp("A", -37.8, 145.0), wp("B", -37.8, 145.01), wp("C", -37.8, 145.02), wp("D", -37.8, 145.03)], flockRoute: pointToPoint })) === "7am run to D via A & 2 more",
    `3 vias → "via A & 2 more"`);

  section("time formatting");
  ok(deriveFlockName(mk({ computedRoutes: [dep("12:00")], flockRoute: pointToPoint })) === "12pm run", "noon → 12pm");
  ok(deriveFlockName(mk({ computedRoutes: [dep("00:00")], flockRoute: pointToPoint })) === "12am run", "midnight → 12am");
  ok(deriveFlockName(mk({ computedRoutes: [dep("13:30")], flockRoute: pointToPoint })) === "1:30pm run", "13:30 → 1:30pm");
  // Most-common departure wins (a connector runner setting off early is an outlier).
  ok(deriveFlockName(mk({ computedRoutes: [dep("06:31"), dep("07:00"), dep("07:00")], flockRoute: pointToPoint })) === "7am run",
    "mode departure ignores the early connector outlier");

  section("graceful degradation");
  ok(deriveFlockName(mk({})) === "run", "empty plan → \"run\"");
  ok(deriveFlockName(mk({ computedRoutes: [dep("07:00")], waypoints: [wp("Waypoint 1", -37.8, 145.0, true)], flockRoute: pointToPoint })) === "7am run",
    "auto-named waypoints are ignored");
  ok(deriveFlockName(mk({ startAnchor: { kind: "departure", time: "08:00" }, waypoints: [wp("Convent Bakery", BAK.lat, BAK.lng)] })) === "8am run to Convent Bakery",
    "no routes yet → falls back to the set anchor time");

  section("a set name overrides the auto one");
  const set = mk({ name: "Sunday Long Run", computedRoutes: [dep("07:00")], flockRoute: pointToPoint });
  ok(flockDisplayName(set) === "Sunday Long Run", "set name wins");
  ok(deriveFlockName(set) === "7am run", "derive still computes underneath");
  ok(flockDisplayName(mk({ name: "   ", computedRoutes: [dep("07:00")], flockRoute: pointToPoint })) === "7am run", "blank set name falls back to auto");

  finish();
}

main();
