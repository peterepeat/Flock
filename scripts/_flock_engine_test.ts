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

console.log(failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
