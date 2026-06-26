// Auto flock-name derivation (pure, OUTPUT-only). Locks the illustrative examples, graceful degradation,
// and that the name's TIME matches The run's summary (anchor-based, never a per-runner computed departure).
//   npx tsx scripts/_st_flockname.ts

import { deriveFlockName, flockDisplayName, flockTimeLabel } from "../src/lib/flockName";
import type { ComputedRoute, FlockSession, FlockWaypoint, TimeAnchor } from "../src/lib/types";
import { ok, suite, section, finish } from "./_st_harness";

const wp = (name: string, lat: number, lng: number, autoNamed = false): FlockWaypoint =>
  ({ id: name, location: { lat, lng }, address: name, name, stopMinutes: 0, autoNamed });
const at = (time: string): TimeAnchor => ({ kind: "departure", time });
const computedDep = (departureTime: string): ComputedRoute =>
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
  ok(deriveFlockName(mk({ flockRoute: pointToPoint })) === "7am run",
    `Auto flock (the nominal 7am) → "7am run"`);
  ok(deriveFlockName(mk({ startAnchor: at("07:30"), waypoints: [wp("Federation Square", FED.lat, FED.lng)], flockRoute: loopAt(FED) })) === "7:30am loop from Federation Square",
    `loop + origin waypoint → "7:30am loop from Federation Square"`);
  ok(deriveFlockName(mk({ startAnchor: at("08:30"), waypoints: [wp("National Gallery of Victoria", NGV.lat, NGV.lng)], flockRoute: pointToPoint })) === "8:30am run to National Gallery of Victoria",
    `dest waypoint → "8:30am run to National Gallery of Victoria"`);
  ok(deriveFlockName(mk({ startAnchor: at("09:30"), waypoints: [wp("Convent Bakery", BAK.lat, BAK.lng), wp("National Gallery of Victoria", NGV.lat, NGV.lng)], flockRoute: pointToPoint })) === "9:30am run to National Gallery of Victoria via Convent Bakery",
    `dest + 1 via → "…run to National Gallery of Victoria via Convent Bakery"`);

  section("the time MATCHES The run's summary (anchor-based, not a computed departure)");
  ok(flockTimeLabel(mk({})) === "7am", "Auto → 7am (the nominal default The run shows)");
  ok(flockTimeLabel(mk({ startAnchor: at("09:15") })) === "9:15am", "a set departure reads its own time");
  ok(flockTimeLabel(mk({ startAnchor: { kind: "waypoint", waypointId: "w", time: "08:45" } })) === "8:45am", "a 'be there by' reads its time");
  // The 8ttzh8 regression: an early connector departure must NOT change the name's time off 7am.
  ok(deriveFlockName(mk({ startAnchor: { kind: "auto" }, computedRoutes: [computedDep("06:22"), computedDep("07:00")], waypoints: [wp("Convent Bakery", BAK.lat, BAK.lng)], flockRoute: pointToPoint })) === "7am run to Convent Bakery",
    "an Auto flock ignores an early computed departure (06:22) — reads 7am, like The run");

  section("shape discrimination");
  ok(deriveFlockName(mk({ waypoints: [wp("National Gallery of Victoria", FAR.lat, FAR.lng)], flockRoute: loopAt({ lat: -37.8, lng: 144.99 }) })) === "7am run to National Gallery of Victoria",
    `loop geometry but FAR waypoint → "run to …" (not "loop from …")`);
  ok(deriveFlockName(mk({ startAnchor: at("06:00"), waypoints: [wp("Federation Square", FED.lat, FED.lng), wp("Convent Bakery", BAK.lat, BAK.lng)], flockRoute: loopAt(FED) })) === "6am loop from Federation Square via Convent Bakery",
    `loop from origin + via stop`);
  ok(deriveFlockName(mk({ waypoints: [wp("A", -37.8, 145.0), wp("B", -37.8, 145.01), wp("C", -37.8, 145.02), wp("D", -37.8, 145.03)], flockRoute: pointToPoint })) === "7am run to D via A & 2 more",
    `3 vias → "via A & 2 more"`);

  section("time formatting");
  ok(deriveFlockName(mk({ startAnchor: at("12:00"), flockRoute: pointToPoint })) === "12pm run", "noon → 12pm");
  ok(deriveFlockName(mk({ startAnchor: at("00:00"), flockRoute: pointToPoint })) === "12am run", "midnight → 12am");
  ok(deriveFlockName(mk({ startAnchor: at("13:30"), flockRoute: pointToPoint })) === "1:30pm run", "13:30 → 1:30pm");

  section("graceful degradation");
  ok(deriveFlockName(mk({})) === "7am run", "empty plan → \"7am run\" (Auto default)");
  ok(deriveFlockName(mk({ waypoints: [wp("Waypoint 1", -37.8, 145.0, true)], flockRoute: pointToPoint })) === "7am run",
    "auto-named waypoints are ignored");
  ok(deriveFlockName(mk({ startAnchor: at("08:00"), waypoints: [wp("Convent Bakery", BAK.lat, BAK.lng)] })) === "8am run to Convent Bakery",
    "no routes yet → still names from the set anchor time + waypoint");

  section("a set name overrides the auto one");
  const set = mk({ name: "Sunday Long Run", flockRoute: pointToPoint });
  ok(flockDisplayName(set) === "Sunday Long Run", "set name wins");
  ok(deriveFlockName(set) === "7am run", "derive still computes underneath");
  ok(flockDisplayName(mk({ name: "   ", flockRoute: pointToPoint })) === "7am run", "blank set name falls back to auto");

  finish();
}

main();
