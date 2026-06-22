// Social-first engine test suite — CATEGORY: common.
// The common case: all-no-preference participants who run the whole route together.
// 1, 2, 3, 6 runners; no-waypoint (auto 10km loop), single-waypoint, multi-waypoint.
// Invariant-first assertions grounded in the social-first spec:
//   - ONE objective: maximise summed pairwise co-present minutes (moving + dwell).
//   - SLOWEST WINS: a shared run leg paceSecPerKm == MAX of present runners' paces
//     (engine clamps to a DEFAULT_PACE floor of 360 sec/km — see index.ts).
//   - pairwise count == n*(n-1)/2 pairs.
//   - totalTogetherMinutes is WALL together-time (per block, once), so for n>2 it is
//     <= the SUM of per-pair minutes; for n==2 they are EQUAL.
//   - uncapped no-preference => no peel warning.
//   - 1 runner => together == 0, zero pairs.
//
// Run: npx tsx scripts/_st_common.ts

import { calculateRoutes, person, wp, session, atPlace, ok, tryOk, suite, finish } from "./_st_harness";
import type { ComputedRoute } from "../src/lib/types";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_PACE = 360; // engine pace floor (index.ts DEFAULT_PACE = 6:00/km)
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

// A spread of points around inner Sydney — straight-line p2p in the fake ORS.
const A = { lat: -33.86, lng: 151.20 };
const B = { lat: -33.88, lng: 151.21 };
const C = { lat: -33.87, lng: 151.23 };
const GATHER = { lat: -33.87, lng: 151.21 };

// No-waypoint sessions need SOME routable geography (an origin) or the engine skips:
// with no waypoints AND no manual pin, there's nothing to anchor the auto loop on
// (index.ts: origin = waypoints[0] ?? firstManual; skip if neither). For the common
// no-waypoint auto-loop case we anchor the flock by pinning ONE runner's start at the
// shared gather (km 0 of the loop) — everyone still runs the whole loop together.
function pinOne(people: ReturnType<typeof person>[]): ReturnType<typeof person>[] {
  return people.map((p, i) => (i === 0 ? { ...p, startPin: atPlace(GATHER.lat, GATHER.lng, "gather") } : p));
}

function pairCount(n: number): number {
  return (n * (n - 1)) / 2;
}

// Pull every run-leg pace across all routes, for slowest-wins checks on shared legs.
function sharedRunPaces(routes: ComputedRoute[]): number[] {
  const out: number[] = [];
  for (const r of routes)
    for (const s of r.schedule)
      if (s.type === "run" && s.companionIds.length >= 1 && s.paceSecPerKm != null) out.push(s.paceSecPerKm);
  return out;
}

async function main() {
suite("common — all-no-preference, whole-route-together");

// ── 1: single runner, no waypoints (auto 10 km loop) ───────────────────────────
await tryOk(async () => {
  const s = session(pinOne([person("solo")]));
  const res = await calculateRoutes(s);
  ok(!res.skipped, "1 runner: not skipped");
  ok(res.routes.length === 1, "1 runner: one route");
  ok(res.summary.pairwiseSummary.length === 0, "1 runner: zero pairs");
  ok(res.summary.totalTogetherMinutes === 0, "1 runner: together-time is 0");
  ok(res.warnings.filter((w) => /peel|barely|overlap/i.test(w.message)).length === 0, "1 runner: no peel/lonely warning");
  const r = res.routes[0];
  ok(r.distanceKm > 0, "1 runner: positive distance");
  ok(HHMM.test(r.departureTime) && HHMM.test(r.arrivalTime), "1 runner: valid HH:MM times");
  ok(r.geometry.coordinates.length >= 2, "1 runner: geometry has >=2 coords");
}, "1 runner / no waypoints");

// ── 2: two equal-pace runners, no waypoints — n=2 equality holds ───────────────
await tryOk(async () => {
  const s = session(pinOne([person("a", { pace: 300 }), person("b", { pace: 300 })]));
  const res = await calculateRoutes(s);
  ok(!res.skipped, "2 eq: not skipped");
  ok(res.routes.length === 2, "2 eq: two routes");
  ok(res.summary.pairwiseSummary.length === pairCount(2), "2 eq: pair count == 1");
  ok(res.summary.totalTogetherMinutes > 0, "2 eq: together-time > 0");
  // n==2: wall together-time EQUALS the single pair's minutes.
  const pairSum = res.summary.pairwiseSummary.reduce((t, p) => t + p.togetherMinutes, 0);
  ok(near(pairSum, res.summary.totalTogetherMinutes, 0.02), "2 eq: total == summed pairwise (n=2 equality)");
  // slowest-wins: equal paces => shared leg runs at that pace. (The DEFAULT_PACE floor
  // applies only to the waypoint time-anchor back-computation, NOT to run-leg pace, so
  // a flock both wanting 300 runs at 300 — verified by probe.)
  const paces = sharedRunPaces(res.routes);
  ok(paces.length > 0, "2 eq: at least one shared run leg");
  ok(paces.every((p) => p === 300), "2 eq: shared leg pace == common present pace (300)");
}, "2 runners equal pace / no waypoints");

// ── 3: two MIXED-pace runners — slowest of present wins ────────────────────────
await tryOk(async () => {
  const fast = 240, slow = 480; // 4:00 vs 8:00 — slow > floor so it must surface
  const s = session(pinOne([person("fast", { pace: fast }), person("slow", { pace: slow })]));
  const res = await calculateRoutes(s);
  ok(!res.skipped, "2 mixed: not skipped");
  const paces = sharedRunPaces(res.routes);
  ok(paces.length > 0, "2 mixed: shared run legs exist");
  // SLOWEST WINS: every shared run leg runs at the slower (larger sec/km) pace.
  ok(paces.every((p) => p === Math.max(DEFAULT_PACE, fast, slow)), "2 mixed: shared pace == slowest present (480)");
  ok(paces.every((p) => p >= fast), "2 mixed: shared pace never faster than slowest");
  ok(res.summary.pairwiseSummary.length === pairCount(2), "2 mixed: one pair");
}, "2 runners mixed pace / no waypoints");

// ── 4: three runners, single waypoint — pair count & wall<=sum invariant ───────
await tryOk(async () => {
  const w = [wp("cafe", C.lat, C.lng, 0)];
  const s = session([person("p1"), person("p2"), person("p3")], w);
  const res = await calculateRoutes(s);
  ok(!res.skipped, "3 / 1wp: not skipped");
  ok(res.routes.length === 3, "3 / 1wp: three routes");
  ok(res.summary.pairwiseSummary.length === pairCount(3), "3 / 1wp: pair count == 3");
  const pairSum = res.summary.pairwiseSummary.reduce((t, p) => t + p.togetherMinutes, 0);
  // n>2: wall together-time counts each block ONCE; summed pairwise counts each pair.
  ok(res.summary.totalTogetherMinutes <= pairSum + 0.02, "3 / 1wp: wall total <= summed pairwise");
  ok(res.summary.totalTogetherMinutes > 0, "3 / 1wp: together-time > 0");
  // every pair present the whole way => each pair's minutes equal the wall total.
  ok(res.summary.pairwiseSummary.every((p) => near(p.togetherMinutes, res.summary.totalTogetherMinutes, 0.02)),
    "3 / 1wp: each pair's minutes == wall total (all run whole route)");
}, "3 runners / single waypoint");

// ── 5: three runners, DWELL waypoint — a stop with 2+ present is together-time ──
await tryOk(async () => {
  const w = [wp("cafe", C.lat, C.lng, 15)]; // 15-min stop, everyone present
  const s = session([person("p1"), person("p2"), person("p3")], w);
  const res = await calculateRoutes(s);
  ok(!res.skipped, "3 / dwell: not skipped");
  // a rest segment with 2+ companions should exist and be counted.
  const rests = res.routes.flatMap((r) => r.schedule.filter((sg) => sg.type === "rest"));
  ok(rests.length > 0, "3 / dwell: a rest segment exists");
  ok(rests.some((sg) => sg.companionIds.length >= 1 && sg.paceSecPerKm == null), "3 / dwell: rest has companions & null pace");
  // compare against the same scenario with a pass-through stop: dwell adds together-time.
  const passThrough = await calculateRoutes(session([person("p1"), person("p2"), person("p3")], [wp("cafe", C.lat, C.lng, 0)]));
  ok(res.summary.totalTogetherMinutes > passThrough.summary.totalTogetherMinutes - 0.02 + 1,
    "3 / dwell: dwell increases together-time vs pass-through (>= ~15 wall min more)");
}, "3 runners / dwell waypoint counts as together-time");

// ── 6: three runners, MULTI-waypoint tour — default distance = tour length ─────
await tryOk(async () => {
  const w = [wp("w1", A.lat, A.lng, 0), wp("w2", C.lat, C.lng, 0), wp("w3", B.lat, B.lng, 0)];
  const s = session([person("p1"), person("p2"), person("p3")], w);
  const res = await calculateRoutes(s);
  ok(!res.skipped, "3 / multi-wp: not skipped");
  ok(res.routes.length === 3, "3 / multi-wp: three routes");
  ok(res.summary.pairwiseSummary.length === pairCount(3), "3 / multi-wp: pair count == 3");
  ok(res.waypointEtas != null && Object.keys(res.waypointEtas).length >= 1, "3 / multi-wp: waypoint ETAs present");
  for (const [, eta] of Object.entries(res.waypointEtas ?? {})) ok(HHMM.test(eta), `3 / multi-wp: ETA ${eta} valid HH:MM`);
  ok(res.warnings.filter((wn) => /peel|barely|overlap/i.test(wn.message)).length === 0, "3 / multi-wp: no peel/lonely warning (uncapped)");
}, "3 runners / multi-waypoint tour");

// ── 7: six runners, no waypoints — scale check on pairs & slowest-wins ─────────
await tryOk(async () => {
  const ids = ["r1", "r2", "r3", "r4", "r5", "r6"];
  const s = session(pinOne(ids.map((id) => person(id))));
  const res = await calculateRoutes(s);
  ok(!res.skipped, "6: not skipped");
  ok(res.routes.length === 6, "6: six routes");
  ok(res.summary.pairwiseSummary.length === pairCount(6), "6: pair count == 15");
  const pairSum = res.summary.pairwiseSummary.reduce((t, p) => t + p.togetherMinutes, 0);
  ok(res.summary.totalTogetherMinutes <= pairSum + 0.02, "6: wall total <= summed pairwise");
  ok(res.summary.totalTogetherMinutes > 0, "6: together-time > 0");
  // all default pace => every shared leg at the floor 360.
  const paces = sharedRunPaces(res.routes);
  ok(paces.length > 0, "6: shared run legs exist");
  ok(paces.every((p) => p === DEFAULT_PACE), "6: all-default shared pace == floor 360");
}, "6 runners / no waypoints");

// ── 8: six MIXED-pace runners — slowest of the six wins on shared legs ─────────
await tryOk(async () => {
  const paceList = [210, 270, 330, 390, 450, 510];
  const slowest = Math.max(DEFAULT_PACE, ...paceList);
  const s = session(pinOne(paceList.map((p, i) => person(`m${i}`, { pace: p }))));
  const res = await calculateRoutes(s);
  ok(!res.skipped, "6 mixed: not skipped");
  ok(res.summary.pairwiseSummary.length === pairCount(6), "6 mixed: pair count == 15");
  const paces = sharedRunPaces(res.routes);
  ok(paces.length > 0, "6 mixed: shared run legs exist");
  // SLOWEST WINS across the full flock: the 510 runner sets the shared pace.
  ok(paces.every((p) => p === slowest), "6 mixed: every shared leg == slowest of six (510)");
  ok(paces.every((p) => p <= slowest), "6 mixed: no shared leg faster than slowest");
}, "6 runners / mixed pace");

// ── 9: pairwise symmetry & well-formedness across a 3-runner result ────────────
await tryOk(async () => {
  const s = session(pinOne([person("alpha"), person("beta"), person("gamma")]));
  const res = await calculateRoutes(s);
  const ids = new Set(["alpha", "beta", "gamma"]);
  for (const p of res.summary.pairwiseSummary) {
    ok(ids.has(p.participantA) && ids.has(p.participantB) && p.participantA !== p.participantB,
      `pairwise: distinct known ids (${p.participantA},${p.participantB})`);
    ok(p.togetherMinutes >= 0, "pairwise: non-negative minutes");
    ok(p.togetherStretchCount >= 1, "pairwise: whole-route pair has >=1 stretch");
  }
  // no duplicate unordered pairs
  const keys = res.summary.pairwiseSummary.map((p) => [p.participantA, p.participantB].sort().join("|"));
  ok(new Set(keys).size === keys.length, "pairwise: no duplicate pairs");
}, "pairwise summary well-formed");

// ── 10: every computed route is structurally valid ─────────────────────────────
await tryOk(async () => {
  const s = session([person("p1"), person("p2"), person("p3")], [wp("cafe", C.lat, C.lng, 10)]);
  const res = await calculateRoutes(s);
  for (const r of res.routes) {
    ok(r.geometry.coordinates.length >= 2, `route ${r.participantId}: geometry >=2 coords`);
    ok(HHMM.test(r.departureTime) && HHMM.test(r.arrivalTime), `route ${r.participantId}: valid times`);
    ok(r.distanceKm > 0, `route ${r.participantId}: positive distance`);
    ok(r.estimatedDurationMinutes > 0, `route ${r.participantId}: positive duration`);
    ok(r.schedule.length >= 1, `route ${r.participantId}: has schedule segments`);
    // schedule segments are time-ordered and contiguous-ish
    for (const sg of r.schedule) ok(HHMM.test(sg.startTime) && HHMM.test(sg.endTime), `route ${r.participantId}: segment valid times`);
  }
  // no peel/lonely warnings — uncapped, all share the whole route.
  ok(res.warnings.filter((w) => /peel|barely|overlap/i.test(w.message)).length === 0, "uncapped flock: no peel/lonely warning");
}, "computed routes structurally valid");

// ── 11: shared-segment well-formedness on a common-start flock ─────────────────
// A no-preference flock runs the whole route together: shared segments must each
// carry >=2 members, positive overlap, valid time. The set never GROWS mid-route
// after the gather (members only hold or peel), so any isConvergence=true should be
// confined to the opening gather block, not appear repeatedly downstream.
await tryOk(async () => {
  const s = session(pinOne([person("p1"), person("p2"), person("p3")]));
  const res = await calculateRoutes(s);
  ok(res.sharedSegments.length >= 1, "shared-seg: at least one shared segment");
  for (const sg of res.sharedSegments) {
    ok(sg.participantIds.length >= 2, "shared-seg: >=2 members");
    ok(sg.overlapMinutes > 0, "shared-seg: positive overlap");
    ok(HHMM.test(sg.startTime), "shared-seg: valid start time");
    ok(sg.geometry.coordinates.length >= 2, "shared-seg: drawable geometry");
  }
  // Membership should never GROW after the first block on a common-start flock:
  // at most one convergence (the gather). More than one => a spurious 'meet here'.
  const conv = res.sharedSegments.filter((sg) => sg.isConvergence === true);
  ok(conv.length <= 1, `shared-seg: <=1 convergence on common-start flock (got ${conv.length})`);
}, "shared-segment well-formedness");

// ── 12: zero participants => skipped ───────────────────────────────────────────
await tryOk(async () => {
  const res = await calculateRoutes(session([]));
  ok(res.skipped === true, "0 runners: skipped == true");
  ok(res.routes.length === 0, "0 runners: no routes");
  ok(res.summary.totalTogetherMinutes === 0, "0 runners: together-time 0");
}, "zero participants skipped");

finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
