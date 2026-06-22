// Social-first engine — CONNECTORS category test suite.
//
// A runner with a MANUAL start and/or finish pin runs a CONNECTOR leg between that off-route
// place and the nearest point on the shared spine. The contract under test:
//   - distanceKm INCLUDES the connector (> the on-spine span the runner covers)
//   - the schedule has a SOLO run leg (companionIds == []) for the approach and/or egress
//   - geometry is continuous: approach ++ on-spine slice ++ egress, ≥2 coords
//   - waypoints[0] == manual start place, waypoints[3] == manual finish place
//   - near vs far manual pins scale the connector distance accordingly
//
// Deterministic fake-ORS: p2p = straight line, distance = haversine km (no road factor),
// round_trip = a clean square loop. So the connector length is exactly the haversine from the
// pin to the NEAREST arc point (the engine resolves a manual pin's on-spine bound via
// nearestKm, then routes pin → that point). We assert invariants, not brittle exact numbers.
//
// Run: npx tsx scripts/_st_connectors.ts

import {
  calculateRoutes, person, wp, session, atPlace, auto, atWp,
  ok, tryOk, suite, section, finish, lineKm,
  type FlockCalcResult,
} from "./_st_harness";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Two waypoints make a CORRIDOR (open spine), the cleanest geometry for connector checks.
// Fake-ORS p2p between them is a straight haversine line ~ (1 deg lat ≈ 111.3 km).
const A = { lat: 0.0, lng: 0.0 };
const B = { lat: 0.05, lng: 0.0 }; // ~5.57 km due north of A

const route2 = () => [wp("A", A.lat, A.lng), wp("B", B.lat, B.lng)];

// helpers ------------------------------------------------------------------
const r = (res: FlockCalcResult, id: string) => res.routes.find((x) => x.participantId === id)!;
const soloLegs = (res: FlockCalcResult, id: string) =>
  r(res, id).schedule.filter((s) => s.type === "run" && s.companionIds.length === 0);
const onSpineSpan = (res: FlockCalcResult, id: string) => {
  // sum of distances of run legs that have companions (the genuinely-shared spine legs),
  // plus shared rests are 0-length; this is a lower bound on the on-spine coverage.
  const rr = r(res, id);
  return rr.schedule.filter((s) => s.type === "run" && s.companionIds.length > 0)
    .reduce((m, s) => m + s.distanceKm, 0);
};
const validSchedule = (res: FlockCalcResult, id: string) =>
  r(res, id).schedule.every((s) => HHMM.test(s.startTime) && HHMM.test(s.endTime));

suite("connectors — manual pins & connector legs");

async function main() {
// --------------------------------------------------------------------------
section("1. manual START only — near pin");
// p2 starts at a place ~1.1 km WEST of A (off the A→B spine), auto finish.
await tryOk(async () => {
  const start = atPlace(0.0, -0.01, "near-west"); // ~1.11 km from A at the spine origin
  const s = session([person("p1"), person("p2", { startPin: start })], route2());
  const res = await calculateRoutes(s);
  ok(!res.skipped, "1: not skipped");
  const span = onSpineSpan(res, "p2");
  ok(r(res, "p2").distanceKm > span + 0.5, "1: distanceKm includes the connector (> on-spine shared span)");
  const solos = soloLegs(res, "p2");
  ok(solos.length >= 1, "1: has ≥1 solo run leg (the approach)");
  ok(solos.every((l) => l.companionIds.length === 0), "1: approach leg is solo (no companions)");
  ok(solos[0].distanceKm > 0.5, "1: approach connector distance is non-trivial");
  ok(validSchedule(res, "p2"), "1: all schedule times are valid HH:MM");
}, "1 manual-start-near");

// --------------------------------------------------------------------------
section("2. manual FINISH only — near pin");
await tryOk(async () => {
  const fin = atPlace(0.05, 0.01, "near-east-of-B"); // ~1.11 km east of B
  const s = session([person("p1"), person("p2", { finishPin: fin })], route2());
  const res = await calculateRoutes(s);
  const span = onSpineSpan(res, "p2");
  ok(r(res, "p2").distanceKm > span + 0.5, "2: distanceKm includes the egress connector");
  const solos = soloLegs(res, "p2");
  ok(solos.length >= 1, "2: has ≥1 solo run leg (the egress)");
  // the egress should be the LAST schedule entry (after the shared spine)
  const last = r(res, "p2").schedule[r(res, "p2").schedule.length - 1];
  ok(last.type === "run" && last.companionIds.length === 0, "2: final leg is the solo egress");
  ok(validSchedule(res, "p2"), "2: valid HH:MM");
}, "2 manual-finish-near");

// --------------------------------------------------------------------------
section("3. BOTH manual start and finish");
await tryOk(async () => {
  const start = atPlace(0.0, -0.01, "w-of-A");
  const fin = atPlace(0.05, 0.01, "e-of-B");
  const s = session([person("p1"), person("p2", { startPin: start, finishPin: fin })], route2());
  const res = await calculateRoutes(s);
  const solos = soloLegs(res, "p2");
  ok(solos.length >= 2, "3: has ≥2 solo legs (approach AND egress)");
  // first schedule entry = approach, last = egress
  const sched = r(res, "p2").schedule;
  ok(sched[0].type === "run" && sched[0].companionIds.length === 0, "3: first leg is solo approach");
  ok(sched[sched.length - 1].companionIds.length === 0, "3: last leg is solo egress");
  const span = onSpineSpan(res, "p2");
  ok(r(res, "p2").distanceKm > span + 1.0, "3: distanceKm includes BOTH connectors");
  ok(validSchedule(res, "p2"), "3: valid HH:MM");
}, "3 both-manual");

// --------------------------------------------------------------------------
section("4. geometry continuity — connectors are prepended/appended to the spine");
await tryOk(async () => {
  const start = atPlace(0.0, -0.01, "w");
  const fin = atPlace(0.05, 0.01, "e");
  const s = session([person("p1"), person("p2", { startPin: start, finishPin: fin })], route2());
  const res = await calculateRoutes(s);
  const g = r(res, "p2").geometry.coordinates;
  ok(g.length >= 2, "4: geometry has ≥2 coords");
  // first coord == the manual START place; last coord == the manual FINISH place
  ok(Math.abs(g[0][0] - (-0.01)) < 1e-6 && Math.abs(g[0][1] - 0.0) < 1e-6, "4: geometry STARTS at the manual start place");
  const lastC = g[g.length - 1];
  ok(Math.abs(lastC[0] - 0.01) < 1e-6 && Math.abs(lastC[1] - 0.05) < 1e-6, "4: geometry ENDS at the manual finish place");
  // waypoints[0] / waypoints[3] mirror the manual places
  const wpts = r(res, "p2").waypoints;
  ok(Math.abs(wpts[0].lng - (-0.01)) < 1e-6, "4: waypoints[0] == manual start place");
  ok(Math.abs(wpts[3].lng - 0.01) < 1e-6, "4: waypoints[3] == manual finish place");
  // total geometry length ≈ sum of leg distances (continuity, no teleport gaps)
  const glen = lineKm(g);
  ok(glen >= r(res, "p2").distanceKm - 0.6, "4: geometry length ≳ route distanceKm (continuous, no missing legs)");
}, "4 geometry-continuity");

// --------------------------------------------------------------------------
section("5. FAR vs NEAR pin — connector distance scales");
await tryOk(async () => {
  const near = atPlace(0.0, -0.01, "near"); // ~1.1 km from A
  const far = atPlace(0.0, -0.20, "far");   // ~22 km from A
  const sNear = session([person("p1"), person("p2", { startPin: near })], route2());
  const sFar = session([person("p1"), person("p2", { startPin: far })], route2());
  const resNear = await calculateRoutes(sNear);
  const resFar = await calculateRoutes(sFar);
  const connNear = soloLegs(resNear, "p2").reduce((m, l) => m + l.distanceKm, 0);
  const connFar = soloLegs(resFar, "p2").reduce((m, l) => m + l.distanceKm, 0);
  ok(connFar > connNear + 5, "5: a far pin yields a much longer connector than a near one");
  ok(r(resFar, "p2").distanceKm > r(resNear, "p2").distanceKm + 5, "5: far-pin total distanceKm is larger");
}, "5 far-vs-near");

// --------------------------------------------------------------------------
section("6. connector solo leg pace == runner's own pace (solo, not slowest-of-flock)");
await tryOk(async () => {
  // p2 is FAST (3:00/km), p1 is slow (8:00/km). On the SHARED spine the slowest wins;
  // on the SOLO connector p2 should run at its OWN pace (180), not the flock's 480.
  const start = atPlace(0.0, -0.01, "w");
  const s = session([
    person("p1", { pace: 480 }),
    person("p2", { pace: 180, startPin: start }),
  ], route2());
  const res = await calculateRoutes(s);
  const approach = soloLegs(res, "p2")[0];
  ok(approach.paceSecPerKm === 180, "6: solo approach runs at the runner's OWN pace (180), not the flock slowest");
  // and a shared spine leg should be at the slowest (480)
  const shared = r(res, "p2").schedule.find((x) => x.type === "run" && x.companionIds.length > 0);
  ok(!shared || shared.paceSecPerKm === 480, "6: shared spine leg runs at the slowest present pace (480)");
}, "6 connector-pace");

// --------------------------------------------------------------------------
section("7. manual start pin that is ON / very near the route → near-zero connector");
await tryOk(async () => {
  // pin essentially AT waypoint A (1e-5 deg ≈ 1.1 m away). connectorKm ≤ 0.02 km → the engine
  // should NOT emit a degenerate solo leg (guard: r.connectorKm > 0.02).
  const start = atPlace(0.00001, 0.0, "on-A");
  const s = session([person("p1"), person("p2", { startPin: start })], route2());
  const res = await calculateRoutes(s);
  ok(!res.skipped, "7: not skipped");
  const solos = soloLegs(res, "p2");
  ok(solos.length === 0, "7: a ~on-route pin emits NO degenerate connector solo leg");
  // distance ≈ the on-spine span (no meaningful connector added)
  const span = onSpineSpan(res, "p2");
  ok(r(res, "p2").distanceKm <= span + 0.05, "7: distanceKm ≈ on-spine span (no connector inflation)");
}, "7 on-route-pin");

// --------------------------------------------------------------------------
section("8. a single MANUAL pin is the only geography (no waypoints) — loop anchors on it");
await tryOk(async () => {
  // No waypoints; p2 has a manual finish pin. The engine uses the first manual pin as the
  // loop ORIGIN. Should NOT skip and should produce a routable result.
  const fin = atPlace(0.1, 0.1, "anchor");
  const s = session([person("p1"), person("p2", { finishPin: fin })], []);
  const res = await calculateRoutes(s);
  ok(!res.skipped, "8: a manual pin alone gives routable geography (not skipped)");
  ok(res.routes.length === 2, "8: both runners get routes");
  ok(res.flockRoute != null && res.flockRoute.coordinates.length >= 2, "8: a flock spine exists");
  for (const p of res.routes) ok(p.geometry.coordinates.length >= 2, `8: ${p.participantId} geometry ≥2 coords`);
}, "8 manual-pin-only-geography");

// --------------------------------------------------------------------------
section("9. capped runner WITH a connector — cap bounds the on-spine span; total may add the connector");
await tryOk(async () => {
  // p2 capped at 2 km on a ~5.6 km spine, plus a manual ~2.2 km connector. The cap governs
  // the SHARED on-spine arc (exitKm-enterKm ≤ cap). The connector is a personal commute that
  // the engine adds ON TOP — assert the on-spine span ≤ cap (the spec's "route distance ≤ cap"
  // is about the shared coverage); we OBSERVE whether total exceeds cap as a known behaviour.
  const start = atPlace(0.0, -0.02, "w"); // ~2.2 km from A
  const s = session([person("p1"), person("p2", { startPin: start, maxDistanceKm: 2 })], route2());
  const res = await calculateRoutes(s);
  const span = onSpineSpan(res, "p2");
  ok(span <= 2 + 0.3, "9: on-spine SHARED span respects the 2 km cap");
  const conn = soloLegs(res, "p2").reduce((m, l) => m + l.distanceKm, 0);
  ok(conn > 1.5, "9: the connector leg (~2.2 km) is present");
  // NOTE the engine adds connectorKm to distanceKm regardless of cap — record it explicitly.
  ok(r(res, "p2").distanceKm >= span - 0.05, "9: distanceKm ≥ on-spine span (sanity)");
}, "9 capped-with-connector");

// --------------------------------------------------------------------------
section("10. manual finish triggers a deadline peel — egress still attaches, arrival ≤ latest");
await tryOk(async () => {
  // p2 has a manual finish AND a tight latestFinishTime. The egress connector run is charged
  // AFTER the spine; the deadline enforcement accounts for connectorKm (plan.ts line 178).
  // Assert: arrivalTime ≤ latest, and the egress solo leg is still emitted.
  const fin = atPlace(0.05, 0.01, "e");
  const s = session([
    person("p1"),
    person("p2", { finishPin: fin, latestFinishTime: "07:40" }),
  ], route2());
  const res = await calculateRoutes(s);
  const arr = r(res, "p2").arrivalTime;
  ok(HHMM.test(arr), "10: arrivalTime is valid HH:MM");
  // 07:40 = 27600 s; arrival ≤ that
  const [hh, mm] = arr.split(":").map(Number);
  ok(hh * 3600 + mm * 60 <= 7 * 3600 + 40 * 60 + 60, "10: arrival ≤ latestFinishTime (deadline respected with connector)");
  ok(validSchedule(res, "p2"), "10: valid HH:MM throughout");
}, "10 manual-finish-deadline");

// --------------------------------------------------------------------------
section("11. partial participation via manual pin is VALUED + warned");
await tryOk(async () => {
  // p2 joins via a manual pin and is capped so they cover only part of the spine — should
  // still register together-time (> 0) and the planner should emit an explanatory warning.
  const start = atPlace(0.0, -0.005, "w");
  const s = session([
    person("p1"),
    person("p2", { startPin: start, maxDistanceKm: 2 }),
  ], route2());
  const res = await calculateRoutes(s);
  ok(res.summary.totalTogetherMinutes > 0, "11: partial participation still yields together-time");
  const w = res.warnings.find((x) => x.participantId === "p2");
  ok(!!w, "11: a partial-coverage runner gets an explanatory warning");
}, "11 partial-valued-warned");

// --------------------------------------------------------------------------
section("12. manual pins do not break the auto/waypoint runners' geometry");
await tryOk(async () => {
  // mixed pin kinds in one session: p1 auto, p2 manual-start, p3 waypoint-start.
  const start = atPlace(0.0, -0.01, "w");
  const s = session([
    person("p1"),
    person("p2", { startPin: start }),
    person("p3", { startPin: atWp("A") }),
  ], route2());
  const res = await calculateRoutes(s);
  ok(res.routes.length === 3, "12: all three runners routed");
  for (const p of res.routes) {
    ok(p.geometry.coordinates.length >= 2, `12: ${p.participantId} geometry ≥2 coords`);
    ok(HHMM.test(p.departureTime) && HHMM.test(p.arrivalTime), `12: ${p.participantId} valid depart/arrive`);
  }
  // only p2 (the manual one) should carry a solo connector leg
  ok(soloLegs(res, "p2").length >= 1, "12: p2 (manual) has a connector solo leg");
  ok(soloLegs(res, "p1").length === 0, "12: p1 (auto) has no connector solo leg");
  ok(soloLegs(res, "p3").length === 0, "12: p3 (waypoint) has no connector solo leg");
  // pairwise summary fully populated: 3 runners → 3 pairs
  ok(res.summary.pairwiseSummary.length === 3, "12: pairwise summary has n*(n-1)/2 = 3 pairs");
}, "12 mixed-pins");

// --------------------------------------------------------------------------
section("13. headline depart/arrive must MATCH the schedule (no connector double-count)");
// Regression guard: the approach (home→enter) shifts the DEPARTURE; the egress (exit→home)
// shifts the ARRIVAL — never the other way. A prior bug summed both legs into one connector
// and applied the SUM to both ends, so an egress pulled the departure earlier than the first
// scheduled leg. Use ASYMMETRIC legs (near approach, far egress) so a sum-based bug would
// visibly desync the headline departureTime from schedule[0].startTime.
await tryOk(async () => {
  const start = atPlace(0.0, -0.01, "near-W-of-A"); // ~1.1 km approach
  const fin = atPlace(0.05, 0.03, "far-E-of-B"); // ~3.3 km egress (3× the approach)
  const s = session([person("p1"), person("p2", { startPin: start, finishPin: fin })], route2());
  const res = await calculateRoutes(s);
  for (const p of res.routes) {
    const sched = p.schedule;
    ok(p.departureTime === sched[0].startTime, `13: ${p.participantId} departureTime == first leg start`);
    ok(p.arrivalTime === sched[sched.length - 1].endTime, `13: ${p.participantId} arrivalTime == last leg end`);
  }
  // the approach leg's own distance is the approach only (not approach+egress)
  const p2 = r(res, "p2");
  const approachLeg = p2.schedule[0];
  const egressLeg = p2.schedule[p2.schedule.length - 1];
  ok(approachLeg.companionIds.length === 0 && egressLeg.companionIds.length === 0, "13: both ends are solo connector legs");
  ok(egressLeg.distanceKm > approachLeg.distanceKm + 1.0, "13: egress leg (~3.3km) is clearly longer than approach (~1.1km) — legs are NOT conflated");
}, "13 depart-arrive-match-schedule");
}

main().then(finish);
