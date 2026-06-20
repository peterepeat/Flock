// Offline unit test for computeFormationPoint (Stage 0). Run:
//   npx --yes tsx scripts/_formation_test.ts
// Pure geometry — no ORS, no server. Asserts the disparate no-op, full overlap,
// partial shared tail, and the < MIN_MERGE rejection.
import { computeFormationPoint, FORMATION_MIN_MERGE_KM } from "../src/lib/flockRoute";
import { distanceMeters } from "../src/lib/geo";
import type { LatLng } from "../src/lib/types";

let pass = 0;
let fail = 0;
const ll = (lat: number, lng: number): LatLng => ({ lat, lng });
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

const wp0 = ll(-37.784, 144.961);

// A north–south shared corridor heading into wp0 from the north (less-negative lat).
const corridor = [ll(-37.772, 144.961), ll(-37.776, 144.961), ll(-37.78, 144.961), wp0];
const F_expected = corridor[0]; // -37.772,144.961 — start of the shared stretch
const corridorKm = (() => {
  let m = 0;
  for (let i = 1; i < corridor.length; i++) m += distanceMeters(corridor[i - 1], corridor[i]);
  return m / 1000;
})();

// (1) Partial shared tail: two homes NW / NE that merge onto the corridor at F.
{
  const A = [ll(-37.77, 144.95), ...corridor]; // NW home → F → wp0
  const B = [ll(-37.77, 144.972), ...corridor]; // NE home → F → wp0
  const F = computeFormationPoint([A, B], wp0);
  check("partial tail fires", F.forkKm >= FORMATION_MIN_MERGE_KM, `forkKm=${F.forkKm.toFixed(3)}`);
  check(
    "partial tail forkKm ≈ corridor length",
    Math.abs(F.forkKm - corridorKm) < 0.05,
    `forkKm=${F.forkKm.toFixed(3)} vs ${corridorKm.toFixed(3)}`,
  );
  check(
    "fork point ≈ F (start of shared stretch)",
    distanceMeters(F.forkPoint, F_expected) < 40,
    `dist=${distanceMeters(F.forkPoint, F_expected).toFixed(0)}m`,
  );
  check("shared geom ends at wp0", distanceMeters(F.sharedFromForkToWp0.at(-1)!, wp0) < 5);
  check("shared geom starts at F", distanceMeters(F.sharedFromForkToWp0[0], F_expected) < 40);
}

// (2) Disparate: homes E / W that only coincide AT wp0 → no merge (byte-identical path).
{
  const A = [ll(-37.77, 144.95), ll(-37.776, 144.955), wp0];
  const B = [ll(-37.77, 144.972), ll(-37.776, 144.967), wp0];
  const F = computeFormationPoint([A, B], wp0);
  check("disparate → forkKm 0", F.forkKm === 0, `forkKm=${F.forkKm}`);
  check("disparate → fork point is wp0", F.forkPoint === wp0);
  check("disparate → empty shared geom", F.sharedFromForkToWp0.length === 0);
}

// (3) Full overlap: identical approaches → tail ≈ the whole approach.
{
  const A = [ll(-37.76, 144.961), ...corridor];
  const F = computeFormationPoint([A, A.slice()], wp0);
  const wholeKm = (() => {
    let m = 0;
    for (let i = 1; i < A.length; i++) m += distanceMeters(A[i - 1], A[i]);
    return m / 1000;
  })();
  check("full overlap forkKm ≈ whole approach", Math.abs(F.forkKm - wholeKm) < 0.05, `forkKm=${F.forkKm.toFixed(3)} vs ${wholeKm.toFixed(3)}`);
}

// (4) Below MIN_MERGE: a tiny shared stub (~300m) must NOT fire.
{
  const shortShared = [ll(-37.7822, 144.961), wp0]; // ~200m
  const A = [ll(-37.77, 144.95), ...shortShared];
  const B = [ll(-37.77, 144.972), ...shortShared];
  const F = computeFormationPoint([A, B], wp0);
  check("sub-MIN_MERGE tail rejected", F.forkKm === 0, `forkKm=${F.forkKm.toFixed(3)}`);
}

// (5) Single approach / empty → no-op.
{
  check("one approach → no-op", computeFormationPoint([[ll(-37.77, 144.95), wp0]], wp0).forkKm === 0);
  check("zero approaches → no-op", computeFormationPoint([], wp0).forkKm === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
