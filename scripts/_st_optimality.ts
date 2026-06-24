// Optimality oracles — the "is the answer OPTIMAL?" layer the invariant suites lack. For small
// instances whose optimum is known analytically (clean straight corridor, pace 6:00/km), assert
// the engine ACHIEVES it; plus VALUE-metamorphic relations (adding company / raising a cap can
// only help). This is the sufficient-condition check that catches degenerate-but-valid answers.
//
//   run: npx tsx scripts/_st_optimality.ts

import { calculateRoutes, person, wp, session, suite, section, ok, tryOk, finish, lineKm, type FlockCalcResult } from "./_st_harness";

const BASE = { lat: -37.81, lng: 144.96 };
const PACE_MIN_PER_KM = 6; // person() default pace 360 s/km
// A straight 2-waypoint corridor (regime W) so length L and the optimum are exactly computable.
const corridor = (km: number) => [wp("w1", BASE.lat, BASE.lng), wp("w2", BASE.lat, BASE.lng + km / 85.39)]; // ~85.39 km per ° lng here
const L = (r: FlockCalcResult) => (r.flockRoute ? lineKm(r.flockRoute.coordinates) : 0);
const pairSum = (r: FlockCalcResult) => r.summary.pairwiseSummary.reduce((s, p) => s + p.togetherMinutes, 0);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const TOL = 2; // minutes: ~0.25 km placement grid × 6 min/km + slack

async function main() {
  suite("optimality oracles");

  // ── O1: two free-ended runners → the optimum is BOTH on the whole route. Together (wall) = L·pace.
  section("O1: two free runners cover the whole route (optimum)");
  await tryOk(async () => {
    const r = await calculateRoutes(session([person("a"), person("b")], corridor(5.4)));
    const opt = L(r) * PACE_MIN_PER_KM; // one pair, full overlap
    ok(near(r.summary.totalTogetherMinutes, opt, TOL), `together ${r.summary.totalTogetherMinutes.toFixed(1)} ≈ optimum ${opt.toFixed(1)} min`);
    ok(near(pairSum(r), opt, TOL), `pairwise-sum ${pairSum(r).toFixed(1)} ≈ ${opt.toFixed(1)}`);
  }, "O1");

  // ── O2: one free + one distance-capped (C<L). Optimum = the capped runner spends its whole C-km
  //        budget overlapping the full-route partner → together = C·pace.
  section("O2: a capped runner overlaps maximally (optimum)");
  await tryOk(async () => {
    const cap = 3;
    const r = await calculateRoutes(session([person("a"), person("b", { maxDistanceKm: cap })], corridor(5.4)));
    const opt = cap * PACE_MIN_PER_KM;
    ok(near(pairSum(r), opt, TOL), `together ${pairSum(r).toFixed(1)} ≈ optimum ${opt.toFixed(1)} min (cap ${cap} km)`);
  }, "O2");

  // ── O3: three free runners → every pair fully overlaps → pairwise-sum = 3·L·pace.
  section("O3: three free runners — all three pairs fully overlap (optimum)");
  await tryOk(async () => {
    const r = await calculateRoutes(session([person("a"), person("b"), person("c")], corridor(5.4)));
    const opt = 3 * L(r) * PACE_MIN_PER_KM;
    ok(near(pairSum(r), opt, 3 * TOL), `pairwise-sum ${pairSum(r).toFixed(1)} ≈ optimum ${opt.toFixed(1)} min`);
  }, "O3");

  // ── MR-V1: adding a co-located runner STRICTLY increases total together-time (value, not shape).
  section("MR-V1: adding company strictly increases together-time");
  await tryOk(async () => {
    const r2 = await calculateRoutes(session([person("a"), person("b")], corridor(5.4)));
    const r3 = await calculateRoutes(session([person("a"), person("b"), person("c")], corridor(5.4)));
    ok(pairSum(r3) > pairSum(r2) + TOL, `3-runner sum ${pairSum(r3).toFixed(1)} > 2-runner sum ${pairSum(r2).toFixed(1)}`);
  }, "MR-V1");

  // ── MR-V2: raising a runner's distance cap never DECREASES total together-time.
  section("MR-V2: raising a cap never reduces together-time");
  await tryOk(async () => {
    const tight = await calculateRoutes(session([person("a"), person("b", { maxDistanceKm: 2 })], corridor(5.4)));
    const loose = await calculateRoutes(session([person("a"), person("b", { maxDistanceKm: 4 })], corridor(5.4)));
    ok(pairSum(loose) >= pairSum(tight) - 0.1, `loose-cap sum ${pairSum(loose).toFixed(1)} ≥ tight-cap sum ${pairSum(tight).toFixed(1)}`);
  }, "MR-V2");

  finish();
}

void main();
