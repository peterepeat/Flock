// Unit test for the social-first planner (src/lib/flock/plan.ts). Pure + deterministic —
// hand-built routes, no ORS. Proves the load-bearing behaviours:
//   • together-time = summed pairwise co-present minutes (the sole objective)
//   • DWELL counts toward together-time for everyone at the stop
//   • SLOWEST present sets a shared leg's pace
//   • a capped runner is placed to maximise overlap — onto the café (dense together-time)
//   • JOIN-FOR-A-BIT: a pinned mid-route window is valued for the span it shares
//   • a partial runner gets an explanatory warning
//   npx tsx scripts/_flock_engine_test.ts
import { planRun } from "../src/lib/flock/plan";
import type { Route, Runner, RunInput } from "../src/lib/flock/model";

let failures = 0;
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) failures++;
}
const f2 = (n: number) => n.toFixed(2);

// A straight 10 km route with a 20-min café stop at 5 km. (coords are unused by the pure
// planner — only cumKm/totalKm/stops matter; projection to geometry comes later.)
function route(km: number, stops: Route["stops"]): Route {
  return { coords: [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.1 }], cumKm: [0, km], totalKm: km, stops };
}
const free = { kind: "free" as const };
const fixed = (km: number) => ({ kind: "fixed" as const, km });
function runner(id: string, pace: number, extra: Partial<Runner> = {}): Runner {
  return { id, pace, enter: free, exit: free, maxDistanceKm: null, earliestSec: null, latestSec: null, approachKm: 0, egressKm: 0, ...extra };
}
const T0 = 7 * 3600;

console.log("── FLOCK PLANNER — social-first behaviours ──\n");

// === Scenario 1: two unconstrained + one capped, with a café ===
{
  console.log("[1] A,B full route + C capped at 6 km · café (20 min) at 5 km");
  const r = route(10, [{ km: 5, durationSec: 1200, name: "Café" }]);
  const input: RunInput = {
    route: r,
    t0Sec: T0,
    runners: [
      runner("A", 360), // 6:00/km
      runner("B", 420), // 7:00/km (slowest)
      runner("C", 360, { maxDistanceKm: 6 }),
    ],
  };
  const plan = planRun(input);
  const C = plan.runners.find((p) => p.id === "C")!;

  ok(plan.togetherMinutes > 0, `together-time computed (${f2(plan.togetherMinutes)} pair-min)`);

  // DWELL counts: the café block has everyone present and contributes pairwise minutes.
  const cafe = plan.blocks.find((b) => b.paceSec === null);
  ok(!!cafe, "a dwell block exists at the café");
  ok(!!cafe && cafe.members.length >= 2, `café dwell is shared (${cafe?.members.length} present) — counts as together-time`);
  ok(!!cafe && (cafe.endSec - cafe.startSec) === 1200, "café dwell is the full 20 min");

  // SLOWEST wins: a leg with A(360) and B(420) present runs at 420.
  const sharedMove = plan.blocks.find((b) => b.paceSec != null && b.members.includes("A") && b.members.includes("B"));
  ok(!!sharedMove && sharedMove.paceSec === 420, `shared A+B leg runs at the slowest pace (420, got ${sharedMove?.paceSec})`);

  // C placed onto the café (dense together-time) rather than an arbitrary 6 km.
  ok(C.enterKm <= 5 && C.exitKm >= 5, `capped C's window covers the café (${f2(C.enterKm)}–${f2(C.exitKm)} km)`);
  ok(C.exitKm - C.enterKm <= 6 + 1e-6, `C stays within their 6 km cap (${f2(C.exitKm - C.enterKm)})`);
  ok(C.togetherMinutes > 0, `C banks together-time (${f2(C.togetherMinutes)} min)`);
  ok(plan.warnings.some((w) => w.id === "C"), "C gets an explanatory warning for not covering the whole route");
  console.log("");
}

// === Scenario 2: join-for-a-bit — a pinned mid-route window is valued ===
{
  console.log("[2] A,B full route + D pinned to run wp@3km → wp@7km only");
  const r = route(10, [{ km: 5, durationSec: 1200, name: "Café" }]);
  const input: RunInput = {
    route: r,
    t0Sec: T0,
    runners: [runner("A", 360), runner("B", 360), runner("D", 360, { enter: fixed(3), exit: fixed(7) })],
  };
  const plan = planRun(input);
  const D = plan.runners.find((p) => p.id === "D")!;
  ok(Math.abs(D.enterKm - 3) < 1e-6 && Math.abs(D.exitKm - 7) < 1e-6, `D's window honoured (${f2(D.enterKm)}–${f2(D.exitKm)})`);
  ok(D.togetherMinutes > 0, `join-for-a-bit is valued — D banks ${f2(D.togetherMinutes)} together-min for the span shared`);
  // D shares the café dwell (it's inside 3–7).
  const cafeWithD = plan.blocks.find((b) => b.paceSec === null && b.members.includes("D"));
  ok(!!cafeWithD, "D shares the café dwell inside their window");
  console.log("");
}

// === Scenario 3: the objective IS summed pairwise minutes (sanity) ===
{
  console.log("[3] objective = Σ pairwise co-present minutes (moving + dwell)");
  const r = route(4, []); // no stop, no caps → everyone together the whole way
  const input: RunInput = { route: r, t0Sec: T0, runners: [runner("A", 360), runner("B", 360), runner("C", 360)] };
  const plan = planRun(input);
  // 4 km at 360 s/km = 1440 s = 24 min, 3 pairs → 72 pair-min.
  ok(Math.abs(plan.togetherMinutes - 72) < 1e-6, `3 runners × 4 km × 6:00 = 72 pair-min (got ${f2(plan.togetherMinutes)})`);
  console.log("");
}

// === Scenario 4: finish-at-reunion — a runner who FINISHES at a stop shares its dwell ===
{
  console.log("[4] finish-at-reunion: stopping at the café for coffee counts as together-time");
  // E finishes AT the café (km5); F runs the whole route. Both should share the café dwell.
  const r = route(10, [{ km: 5, durationSec: 1800, name: "Café" }]);
  const input: RunInput = {
    route: r,
    t0Sec: T0,
    runners: [runner("E", 360, { exit: fixed(5) }), runner("F", 360)],
  };
  const plan = planRun(input);
  const cafe = plan.blocks.find((b) => b.paceSec === null);
  ok(!!cafe && cafe.members.includes("E") && cafe.members.includes("F"), "the finisher E shares the café dwell (not excluded by finishing there)");
  const E = plan.runners.find((p) => p.id === "E")!;
  // E: 5 km @ 6:00 (30 min) shared moving + 30 min café = 60 min, all with F.
  ok(Math.abs(E.togetherMinutes - 60) < 1e-6, `E banks the café reunion: 30 min run + 30 min coffee = 60 min (got ${f2(E.togetherMinutes)})`);
  console.log("");
}

// === Scenario 5: a deadline that cuts the dwell SPLITS it (finisher leaves early, not trimmed off) ===
{
  console.log("[5] deadline mid-dwell splits the café; the finisher keeps the overlap, isn't evicted");
  // G finishes at the café (km5, reached at 1800 s under 360), deadline 2100 s cuts the 30-min dwell.
  const r = route(10, [{ km: 5, durationSec: 1800, name: "Café" }]);
  const input: RunInput = {
    route: r,
    t0Sec: 0,
    runners: [runner("H", 360), runner("G", 360, { exit: fixed(5), latestSec: 2100 })],
  };
  const plan = planRun(input);
  const G = plan.runners.find((p) => p.id === "G")!;
  // G runs [0,5] (reaches café at 1800 s) and stays the 5 min to its 2100 s deadline — NOT trimmed before the café.
  ok(Math.abs(G.exitKm - 5) < 1e-6, `G still finishes AT the café (exit ${f2(G.exitKm)} km), not trimmed short by the deadline`);
  ok(G.arriveSec <= 2100 + 1e-6, `G honours its 2100 s deadline (leaves the café at ${G.arriveSec} s)`);
  // 30 min shared run + 5 min café overlap = 35 min.
  ok(Math.abs(G.togetherMinutes - 35) < 1e-6, `G keeps the run + the 5 min of café before its deadline = 35 min (got ${f2(G.togetherMinutes)})`);
  const split = plan.blocks.filter((b) => b.paceSec === null);
  ok(split.length === 2, `the café dwell splits at the deadline into ${split.length} sub-blocks`);
  console.log("");
}

// === Scenario 6: an OPENING dwell — departure matches the rest, not the post-dwell leg ===
{
  console.log("[6] opening café (km0): departure is the rest start, not after it");
  const r = route(10, [{ km: 0, durationSec: 900, name: "Start café" }]);
  const input: RunInput = { route: r, t0Sec: T0, runners: [runner("A", 360), runner("B", 360)] };
  const plan = planRun(input);
  const A = plan.runners.find((p) => p.id === "A")!;
  ok(Math.abs(A.departSec - T0) < 1e-6, `A departs at the opening-rest start (${A.departSec} s), not 900 s later`);
  console.log("");
}

// === Scenario 7: deadline-snap — a deadline-bound runner finishes AT a reachable café ===
{
  console.log("[7] a tight deadline routes a fast runner to FINISH at the café, not peel off before it");
  // FAST (4:00/km, must finish by 8500 s) + SLOW (6:00/km, free). Café @4km, dwell 2h. Under
  // slowest-wins FAST is dragged to 6:00 and would clear the café only at ~9360 s — past the
  // deadline — so the naive trim peels FAST off at ~2.4km BEFORE the café (14.5 pair-min). The
  // reunion-aware deadline snap instead finishes FAST at the café and parks to the deadline.
  const r = route(6, [{ km: 4, durationSec: 7200, name: "Café" }]);
  const input: RunInput = {
    route: r,
    t0Sec: 0,
    runners: [runner("FAST", 240, { latestSec: 8500 }), runner("SLOW", 360)],
  };
  const plan = planRun(input);
  const FAST = plan.runners.find((p) => p.id === "FAST")!;
  ok(Math.abs(FAST.exitKm - 4) < 1e-6, `FAST finishes AT the café (exit ${f2(FAST.exitKm)} km), not trimmed off before it`);
  ok(FAST.arriveSec <= 8500 + 1e-6, `FAST honours the 8500 s deadline (finishes ${FAST.arriveSec} s)`);
  ok(plan.togetherMinutes > 100, `the reunion is banked: ${f2(plan.togetherMinutes)} pair-min (vs 14.5 if peeled off before the café)`);
  console.log("");
}

console.log(failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
