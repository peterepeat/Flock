// Golden OUTCOME oracles for the social-first engine — the missing "is the answer GOOD?" layer.
// Unlike the invariant suites (which only assert NO constraint is violated), these assert the
// RESULT IS SENSIBLE: the spine is centred on the runners, a solo runner covers their route, and
// no-geography is a NAMED error. Each case mirrors a real scenario a user hit. Deterministic
// fake-ORS (straight p2p, square loops) makes the geometry exactly computable, so we assert on it.
//
//   run: npx tsx scripts/_st_golden.ts

import { calculateRoutes, person, wp, atPlace, session, suite, section, ok, tryOk, finish, lineKm, type FlockCalcResult } from "./_st_harness";
import { centroid, distanceMeters } from "../src/lib/geo";
import type { LatLng } from "../src/lib/types";

const BASE = { lat: -37.81, lng: 144.96 };
const at = (dLat: number, dLng: number): LatLng => ({ lat: BASE.lat + dLat, lng: BASE.lng + dLng });
const R = (r: FlockCalcResult, id: string) => r.routes.find((x) => x.participantId === id);
const spineKm = (r: FlockCalcResult) => (r.flockRoute ? lineKm(r.flockRoute.coordinates) : 0);
const coordAt = (r: FlockCalcResult, i: number): LatLng | null => {
  const c = r.flockRoute?.coordinates;
  if (!c || c.length === 0) return null;
  const [lng, lat] = c[i < 0 ? c.length + i : i];
  return { lat, lng };
};

async function main() {
  suite("golden outcome oracles");

  // ── 1. Two runners, manual starts apart, no waypoints → the spine is CENTRED between them,
  //       not anchored on whoever happens to be first. (The reported #1.)
  section("1. spine is centred between two runners (no waypoints)");
  await tryOk(async () => {
    const P = at(0, 0), C = at(0, 0.06); // ~5.3 km apart
    const r = await calculateRoutes(session([
      person("peter", { startPin: atPlace(P.lat, P.lng) }),
      person("collin", { startPin: atPlace(C.lat, C.lng) }),
    ]));
    ok(!r.skipped && r.flockRoute != null, "routable (a spine is built)");
    const base = coordAt(r, 0)!;
    const mid = centroid([P, C]);
    ok(distanceMeters(base, mid) < 500, `spine sits at the midpoint of the two starts (off by ${Math.round(distanceMeters(base, mid))} m)`);
    ok(distanceMeters(base, P) > 1500 && distanceMeters(base, C) > 1500, "spine is NOT anchored on either runner's pin");
    ok(r.summary.totalTogetherMinutes > 0, "the two runners actually share time on it");
  }, "1 centred-spine");

  // ── 2. No waypoints, all-auto → a NAMED no-route (not a silent skip that spins forever). (#2)
  section("2. no geography → a named no-route error");
  await tryOk(async () => {
    const r = await calculateRoutes(session([person("a"), person("b")]));
    ok(r.unroutable?.reason === "no-location", `unroutable.reason === "no-location" (got ${JSON.stringify(r.unroutable)})`);
    ok(r.skipped === true, "skipped alias still true (back-compat)");
    ok(r.routes.length === 0, "no routes produced");
  }, "2 named-no-route");

  // ── 3. Auto runners + a fixed location + one waypoint → a loop IS built and both run it. (#3)
  section("3. fixed location + one waypoint + auto → a loop runs");
  await tryOk(async () => {
    const r = await calculateRoutes(session(
      [person("a", { startPin: atPlace(at(0, 0).lat, at(0, 0).lng) }), person("b")],
      [wp("w1", at(0.02, 0.02).lat, at(0.02, 0.02).lng)],
      { intendedDistanceKm: 8 },
    ));
    ok(!r.skipped && r.flockRoute != null, "a loop is built (not skipped)");
    ok((R(r, "a")?.distanceKm ?? 0) > 1 && (R(r, "b")?.distanceKm ?? 0) > 1, "both runners run real distance");
  }, "3 loop-runs");

  // ── 4. One waypoint, one runner with start+finish → the spine IS the runner's own A→B route,
  //       fully traversed (not a flock loop nobody runs). (#4)
  section("4. single runner's spine is their own route, fully run");
  await tryOk(async () => {
    const S = at(0, 0), Wp = at(0.02, 0.02), F = at(0.04, 0);
    const r = await calculateRoutes(session(
      [person("solo", { startPin: atPlace(S.lat, S.lng), finishPin: atPlace(F.lat, F.lng) })],
      [wp("w1", Wp.lat, Wp.lng)],
    ));
    ok(!r.skipped && r.flockRoute != null, "routable");
    ok((R(r, "solo")?.distanceKm ?? 0) >= spineKm(r) * 0.9, `solo covers ~the whole spine (${R(r, "solo")?.distanceKm} of ${spineKm(r).toFixed(2)} km)`);
    ok(distanceMeters(coordAt(r, 0)!, S) < 300 && distanceMeters(coordAt(r, -1)!, F) < 300, "spine runs from the runner's start to their finish");
  }, "4 own-route");

  // ── 5. Detailed multi-waypoint route returning to the start, one runner, free start, a finish
  //       pinned at the return point → the runner covers the WHOLE route (the lastNearKm fix). (#5)
  section("5. solo with a return-to-start finish covers the whole route");
  await tryOk(async () => {
    const w0 = at(0, 0);
    const r = await calculateRoutes(session(
      [person("solo", { finishPin: atPlace(w0.lat, w0.lng) })], // finish back where the route starts
      [wp("w0", w0.lat, w0.lng), wp("w1", at(0, 0.03).lat, at(0, 0.03).lng), wp("w2", at(0.03, 0.03).lat, at(0.03, 0.03).lng), wp("w3", w0.lat, w0.lng)],
    ));
    ok(!r.skipped, "routable");
    ok((R(r, "solo")?.distanceKm ?? 0) >= spineKm(r) * 0.9, `solo covers ~the whole route, not km≈0 (${R(r, "solo")?.distanceKm} of ${spineKm(r).toFixed(2)} km)`);
  }, "5 return-finish-coverage");

  // ── 6. Single all-auto runner, no waypoints → no-location (a lone runner with no place to run).
  section("6. lone all-auto runner, no geography → named no-route");
  await tryOk(async () => {
    const r = await calculateRoutes(session([person("solo")]));
    ok(r.unroutable?.reason === "no-location", `unroutable "no-location" (got ${JSON.stringify(r.unroutable)})`);
  }, "6 lone-no-route");

  // ── 7. Coverage floor: an unconstrained solo runner on a ≥2-waypoint corridor covers all of it.
  section("7. unconstrained solo runner covers the full corridor");
  await tryOk(async () => {
    const r = await calculateRoutes(session([person("solo")], [wp("w1", at(0, 0).lat, at(0, 0).lng), wp("w2", at(0, 0.05).lat, at(0, 0.05).lng)]));
    ok((R(r, "solo")?.distanceKm ?? 0) >= spineKm(r) * 0.95, `solo covers ≥95% of the corridor (${R(r, "solo")?.distanceKm} of ${spineKm(r).toFixed(2)} km)`);
  }, "7 solo-coverage");

  finish();
}

void main();
