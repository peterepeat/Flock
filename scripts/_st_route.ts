// Route-construction test suite for the social-first Flock engine.
// Category: route — route construction + intended distance + stops.
//   npx tsx scripts/_st_route.ts
//
// Invariant-first: the deterministic fake-ORS makes p2p a straight haversine line
// and round_trip a clean square of the requested perimeter, so route geometry length
// and waypoint counts are exactly computable. We prefer inequalities / structural
// invariants over guessing incidental exact numbers.

import {
  calculateRoutes, person, wp, session, ok, tryOk, suite, section, finish, lineKm,
  atPlace,
} from "./_st_harness";

// --- small local helpers ---
const HHMM = /^\d{2}:\d{2}$/;
const toMin = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

async function main() {
suite("route");

// ─────────────────────────────────────────────────────────────────────────────
section("1. single waypoint → loop, default intended distance = 10km when <=1 wp");
await tryOk(async () => {
  const s = session(
    [person("a"), person("b")],
    [wp("cafe", -37.81, 144.96, 0)],
    // intendedDistanceKm null → default. With <=1 waypoint, default is 10 km.
  );
  const r = await calculateRoutes(s);
  ok(r.skipped !== true, "not skipped (2 runners, 1 waypoint)");
  ok(r.flockRoute != null, "flock route present");
  if (r.flockRoute) {
    const coords = r.flockRoute.coordinates;
    ok(coords.length >= 2, `flock geometry has >=2 coords (got ${coords.length})`);
    const len = lineKm(coords);
    // <=1 waypoint default is ~10km loop. Allow generous tolerance — engine may
    // grow/adjust to seat runners, but should be in the ballpark of the default.
    ok(len > 3, `flock route length non-trivial (${len.toFixed(2)}km)`);
    ok(len < 40, `flock route length not runaway (${len.toFixed(2)}km)`);
  }
  // every route geometry non-empty + valid HH:MM clock
  for (const rt of r.routes) {
    ok(rt.geometry.coordinates.length >= 2, `${rt.participantId} geometry >=2 coords`);
    ok(HHMM.test(rt.departureTime), `${rt.participantId} departureTime valid HH:MM (${rt.departureTime})`);
    ok(HHMM.test(rt.arrivalTime), `${rt.participantId} arrivalTime valid HH:MM (${rt.arrivalTime})`);
    ok(toMin(rt.arrivalTime) >= toMin(rt.departureTime), `${rt.participantId} arrives after departs`);
    ok(isFiniteNum(rt.distanceKm) && rt.distanceKm > 0, `${rt.participantId} distanceKm > 0`);
  }
}, "single-waypoint loop");

// ─────────────────────────────────────────────────────────────────────────────
section("2. no waypoints, all-auto pins → no routable geography ⇒ skipped");
await tryOk(async () => {
  // Two all-auto participants, no waypoints, no manual pins: there is literally no
  // concrete coordinate to anchor a route on. Per spec, "no routable geography" ⇒ skipped.
  // (Contrast scenario 10: a manual start-pin gives an origin and DOES build a loop.)
  const s = session([person("a"), person("b")]);
  const r = await calculateRoutes(s);
  ok(r.skipped === true, "all-auto + no waypoints ⇒ skipped:true (no routable geography)");
  if (!r.skipped) {
    // If the engine instead chooses to synthesize a loop, it must at least be coherent.
    ok(r.flockRoute != null, "if not skipped, a flock route must exist");
  }
}, "no-geography skipped");

// ─────────────────────────────────────────────────────────────────────────────
section("3. two-waypoint corridor — geometry spans both waypoints");
await tryOk(async () => {
  const w1 = wp("w1", -37.81, 144.96, 0);
  const w2 = wp("w2", -37.79, 145.00, 0); // ~4-5km away
  const s = session([person("a"), person("b")], [w1, w2]);
  const r = await calculateRoutes(s);
  ok(r.skipped !== true, "not skipped (corridor)");
  ok(r.flockRoute != null, "corridor flock route present");
  // both waypoints get an ETA
  ok(r.waypointEtas != null, "waypointEtas present");
  if (r.waypointEtas) {
    ok(HHMM.test(r.waypointEtas["w1"] ?? ""), "w1 has valid ETA");
    ok(HHMM.test(r.waypointEtas["w2"] ?? ""), "w2 has valid ETA");
    ok(toMin(r.waypointEtas["w2"]) >= toMin(r.waypointEtas["w1"]), "w2 ETA >= w1 ETA (monotonic in tour order)");
  }
}, "two-waypoint corridor");

// ─────────────────────────────────────────────────────────────────────────────
section("4. many waypoints — each stop has an ETA, ETAs monotonic");
await tryOk(async () => {
  const wps = [
    wp("s1", -37.81, 144.96, 0),
    wp("s2", -37.80, 144.98, 0),
    wp("s3", -37.79, 145.00, 0),
    wp("s4", -37.78, 145.02, 0),
  ];
  const s = session([person("a"), person("b")], wps);
  const r = await calculateRoutes(s);
  ok(r.skipped !== true, "not skipped (4 waypoints)");
  ok(r.waypointEtas != null, "waypointEtas present for 4 waypoints");
  if (r.waypointEtas) {
    const ids = wps.map((w) => w.id);
    for (const id of ids) ok(HHMM.test(r.waypointEtas![id] ?? ""), `${id} has valid ETA (${r.waypointEtas![id]})`);
    const mins = ids.map((id) => toMin(r.waypointEtas![id] ?? "00:00"));
    let mono = true;
    for (let i = 1; i < mins.length; i++) if (mins[i] < mins[i - 1]) mono = false;
    ok(mono, `ETAs monotonic non-decreasing in tour order (${mins.join(",")})`);
  }
}, "many-waypoint tour");

// ─────────────────────────────────────────────────────────────────────────────
section("5. intended distance = null → tour length (>1 waypoint)");
await tryOk(async () => {
  const wps = [
    wp("t1", -37.81, 144.96, 0),
    wp("t2", -37.79, 144.99, 0),
    wp("t3", -37.77, 145.02, 0),
  ];
  // straight-line tour length s->t1->t2->t3->finish; we just assert the flock route
  // is at least as long as the bare waypoint-to-waypoint chain (it must reach them all).
  const chain = lineKm([
    [wps[0].location.lng, wps[0].location.lat],
    [wps[1].location.lng, wps[1].location.lat],
    [wps[2].location.lng, wps[2].location.lat],
  ]);
  const s = session([person("a"), person("b")], wps);
  const r = await calculateRoutes(s);
  ok(r.flockRoute != null, "tour flock route present");
  if (r.flockRoute) {
    const len = lineKm(r.flockRoute.coordinates);
    ok(len >= chain - 0.5, `flock route covers the waypoint chain (route ${len.toFixed(2)} >= chain ${chain.toFixed(2)})`);
  }
}, "intended null → tour length");

// ─────────────────────────────────────────────────────────────────────────────
section("6. intended distance > tour → route grows toward intended");
await tryOk(async () => {
  const wps = [wp("g1", -37.81, 144.96, 0), wp("g2", -37.805, 144.965, 0)]; // very close, tiny tour
  const tiny = lineKm([
    [wps[0].location.lng, wps[0].location.lat],
    [wps[1].location.lng, wps[1].location.lat],
  ]);
  const s = session([person("a"), person("b")], wps, { intendedDistanceKm: 12 });
  const r = await calculateRoutes(s);
  ok(r.flockRoute != null, "grown flock route present");
  if (r.flockRoute) {
    const len = lineKm(r.flockRoute.coordinates);
    // route should grow well beyond the tiny natural tour toward the 12km target.
    ok(len > tiny + 1, `route grew beyond tiny tour (route ${len.toFixed(2)} vs tour ${tiny.toFixed(2)})`);
    ok(len <= 20, `route did not wildly overshoot the 12km target (${len.toFixed(2)}km)`);
  }
}, "intended > tour grows");

// ─────────────────────────────────────────────────────────────────────────────
section("7. intended distance < tour → still covers all waypoints (cannot skip stops)");
await tryOk(async () => {
  const wps = [
    wp("u1", -37.81, 144.96, 0),
    wp("u2", -37.77, 145.02, 0), // far → tour is large
    wp("u3", -37.73, 145.08, 0),
  ];
  const chain = lineKm([
    [wps[0].location.lng, wps[0].location.lat],
    [wps[1].location.lng, wps[1].location.lat],
    [wps[2].location.lng, wps[2].location.lat],
  ]);
  const s = session([person("a"), person("b")], wps, { intendedDistanceKm: 2 });
  const r = await calculateRoutes(s);
  ok(r.flockRoute != null, "route present when intended < tour");
  if (r.flockRoute && r.waypointEtas) {
    // The waypoints are required; the route cannot be shorter than reaching them all.
    const len = lineKm(r.flockRoute.coordinates);
    ok(len >= chain - 0.5, `route still spans all waypoints despite small intended (${len.toFixed(2)} >= ${chain.toFixed(2)})`);
    for (const w of wps) ok(HHMM.test(r.waypointEtas[w.id] ?? ""), `${w.id} still has ETA`);
  }
}, "intended < tour covers waypoints");

// ─────────────────────────────────────────────────────────────────────────────
section("8. multiple stops with dwell → ETAs gap by at least dwell, dwell appears as rest");
await tryOk(async () => {
  const wps = [
    wp("d1", -37.81, 144.96, 10), // 10 min dwell
    wp("d2", -37.79, 144.99, 5),  // 5 min dwell
  ];
  const s = session([person("a"), person("b")], wps);
  const r = await calculateRoutes(s);
  ok(r.skipped !== true, "not skipped (dwell tour)");
  if (r.waypointEtas) {
    const e1 = toMin(r.waypointEtas["d1"] ?? "00:00");
    const e2 = toMin(r.waypointEtas["d2"] ?? "00:00");
    // d2 ETA is reached after d1 ETA + d1's 10-min dwell + travel between them.
    ok(e2 >= e1 + 10, `d2 ETA accounts for d1's 10-min dwell + travel (gap ${e2 - e1}min)`);
  }
  // each route should contain at least one rest segment (the shared dwell) with companions
  const restWithCompany = r.routes.some((rt) =>
    rt.schedule.some((seg) => seg.type === "rest" && seg.companionIds.length >= 1),
  );
  ok(restWithCompany, "a shared dwell appears as a rest segment with companions");
  // rest segments have null pace
  for (const rt of r.routes) {
    for (const seg of rt.schedule) {
      if (seg.type === "rest") ok(seg.paceSecPerKm === null, `${rt.participantId} rest seg has null pace`);
    }
  }
}, "dwell stops");

// ─────────────────────────────────────────────────────────────────────────────
section("9. dwell counts toward together-time (totalTogetherMinutes includes dwell)");
await tryOk(async () => {
  // Two identical runners on a corridor with a long dwell — together-time must be > 0
  // and at least the dwell length, since both are co-present at the stop.
  const wps = [wp("c1", -37.81, 144.96, 20)];
  const s = session([person("a"), person("b")], wps);
  const r = await calculateRoutes(s);
  ok(r.summary.totalTogetherMinutes > 0, `together-time positive (${r.summary.totalTogetherMinutes}min)`);
  ok(r.summary.totalTogetherMinutes >= 20, `together-time includes the 20-min dwell (${r.summary.totalTogetherMinutes}min)`);
}, "dwell counts as together-time");

// ─────────────────────────────────────────────────────────────────────────────
section("10. no waypoints + a manual-pin participant → origin fallback builds a loop");
await tryOk(async () => {
  const s = session([
    person("a", { startPin: atPlace(-37.81, 144.96, "home") }),
    person("b", { startPin: atPlace(-37.81, 144.96, "home") }),
  ]);
  const r = await calculateRoutes(s);
  ok(r.skipped !== true, "not skipped (manual-pin origin fallback)");
  ok(r.flockRoute != null, "loop built from manual-pin origin");
  if (r.flockRoute) {
    const len = lineKm(r.flockRoute.coordinates);
    ok(len > 1, `origin-fallback loop has real length (${len.toFixed(2)}km)`);
  }
}, "manual-pin origin fallback loop");

// ─────────────────────────────────────────────────────────────────────────────
section("11. 0 participants → skipped");
await tryOk(async () => {
  const s = session([], [wp("z1", -37.81, 144.96, 0)]);
  const r = await calculateRoutes(s);
  ok(r.skipped === true, "0 participants → skipped:true");
}, "zero participants skipped");

// ─────────────────────────────────────────────────────────────────────────────
section("12. pairwise summary completeness — n*(n-1)/2 pairs for 3 runners");
await tryOk(async () => {
  const wps = [wp("p1", -37.81, 144.96, 5), wp("p2", -37.79, 144.99, 0)];
  const s = session([person("a"), person("b"), person("c")], wps);
  const r = await calculateRoutes(s);
  ok(r.skipped !== true, "not skipped (3 runners)");
  const n = 3;
  const expected = (n * (n - 1)) / 2;
  ok(
    r.summary.pairwiseSummary.length === expected,
    `pairwise summary has n*(n-1)/2 = ${expected} pairs (got ${r.summary.pairwiseSummary.length})`,
  );
  // together stretch counts and minutes are non-negative
  for (const p of r.summary.pairwiseSummary) {
    ok(p.togetherMinutes >= 0, `${p.participantA}/${p.participantB} togetherMinutes >= 0`);
    ok(p.togetherStretchCount >= 0, `${p.participantA}/${p.participantB} stretch count >= 0`);
  }
  // ETAs of the two stops monotonic
  if (r.waypointEtas) {
    ok(toMin(r.waypointEtas["p2"] ?? "23:59") >= toMin(r.waypointEtas["p1"] ?? "00:00"), "p2 ETA >= p1 ETA");
  }
}, "pairwise completeness");

  finish();
}

main();
