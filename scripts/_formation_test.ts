// Offline unit test for computeFormationPoint (Stage 0). Run:
//   npx --yes tsx scripts/_formation_test.ts
// Pure geometry — no ORS, no server. Asserts the disparate no-op, full overlap,
// partial shared tail, and the < MIN_MERGE rejection.
import { computeDispersalPoint, computeForcedMeetingPoint, computeFormationPoint, FORMATION_MIN_MERGE_KM } from "../src/lib/flockRoute";
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

// ---------------------------------------------------------------------------
// computeDispersalPoint (D) — the egress-side mirror of F.
// ---------------------------------------------------------------------------
const end = ll(-37.805, 144.972); // backbone end (e.g. CarltonGardens)
// A shared corridor heading EAST out of the end, then a split to NE / SE finishes.
const eastCorridor = [end, ll(-37.805, 144.976), ll(-37.805, 144.98), ll(-37.805, 144.984)];
const D_expected = eastCorridor[eastCorridor.length - 1]; // -37.805,144.984 — the split point
const eastKm = (() => {
  let m = 0;
  for (let i = 1; i < eastCorridor.length; i++) m += distanceMeters(eastCorridor[i - 1], eastCorridor[i]);
  return m / 1000;
})();

// (6) Shared egress corridor then split → D fires at the divergence.
{
  const egA = [...eastCorridor, ll(-37.8, 144.99)]; // end → D → NE finish
  const egB = [...eastCorridor, ll(-37.81, 144.99)]; // end → D → SE finish
  const D = computeDispersalPoint([egA, egB], end);
  check("dispersal fires", D.dispKm >= FORMATION_MIN_MERGE_KM, `dispKm=${D.dispKm.toFixed(3)}`);
  check("dispersal dispKm ≈ shared corridor", Math.abs(D.dispKm - eastKm) < 0.05, `dispKm=${D.dispKm.toFixed(3)} vs ${eastKm.toFixed(3)}`);
  check("dispersal point ≈ D (split)", distanceMeters(D.dispPoint, D_expected) < 40, `dist=${distanceMeters(D.dispPoint, D_expected).toFixed(0)}m`);
  check("shared geom starts at backbone end", distanceMeters(D.sharedFromEndToD[0], end) < 5);
  check("shared geom ends at D", distanceMeters(D.sharedFromEndToD.at(-1)!, D_expected) < 40);
}

// (7) Disparate finishes (split immediately at the end) → no dispersal (byte-identical egress).
{
  const egA = [end, ll(-37.8, 144.978), ll(-37.795, 144.985)]; // straight NE
  const egB = [end, ll(-37.81, 144.978), ll(-37.815, 144.985)]; // straight SE
  const D = computeDispersalPoint([egA, egB], end);
  check("disparate finishes → dispKm 0", D.dispKm === 0, `dispKm=${D.dispKm}`);
  check("disparate finishes → empty shared geom", D.sharedFromEndToD.length === 0);
}

// ---------------------------------------------------------------------------
// computeForcedMeetingPoint (Stage 1) — the synthetic meeting point P for runners
// who share NO road into the waypoint. Pure geometry (crow + road factor); the
// real ORS commit + value gate live in routeEngine.
// ---------------------------------------------------------------------------
{
  const wpF = ll(-37.8, 144.98);
  const hA = ll(-37.764, 144.98); //  ~4km due N  → bearing to wp0 ≈ 180°
  const hB = ll(-37.78, 145.018); //  ~4km NE    → bearing to wp0 ≈ 237°  ⇒ spread ≈ 57°
  const apprA = distanceMeters(hA, wpF) / 1000;
  const apprB = distanceMeters(hB, wpF) / 1000;

  // 57° V with generous slack → fires, and P sits measurably back from the waypoint.
  const P = computeForcedMeetingPoint([hA, hB], [apprA, apprB], [10, 10], wpF, 1.3);
  check("forced V (57°) with slack → fires", P !== null);
  if (P) check("forced P sits back from wp0", distanceMeters(P, wpF) / 1000 > 0.3, `dist=${(distanceMeters(P, wpF) / 1000).toFixed(2)}km`);

  // Same V, ~zero slack → nobody can afford the detour → null.
  const tight = computeForcedMeetingPoint([hA, hB], [apprA, apprB], [0.1, 0.1], wpF, 1.3);
  check("forced V no slack → null", tight === null);

  // Near-collinear (~same bearing into wp0) → below the spread floor → null.
  const c1 = ll(-37.764, 144.98);
  const c2 = ll(-37.766, 144.981);
  const collinear = computeForcedMeetingPoint(
    [c1, c2],
    [distanceMeters(c1, wpF) / 1000, distanceMeters(c2, wpF) / 1000],
    [10, 10],
    wpF,
    1.3,
  );
  check("forced near-collinear → null", collinear === null);

  // Opposite sides (~180° apart) → above the spread ceiling → null.
  const o1 = ll(-37.764, 144.98); // N
  const o2 = ll(-37.836, 144.98); // S
  const opp = computeForcedMeetingPoint(
    [o1, o2],
    [distanceMeters(o1, wpF) / 1000, distanceMeters(o2, wpF) / 1000],
    [10, 10],
    wpF,
    1.3,
  );
  check("forced opposite (~180°) → null", opp === null);

  // Single home → no-op.
  check("forced one home → null", computeForcedMeetingPoint([hA], [apprA], [10], wpF, 1.3) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
