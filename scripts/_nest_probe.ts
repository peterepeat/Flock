// NESTED-STRUCTURE MAKE-OR-BREAK PROBE — gate for the nested-shared-structure plan
// (~/.claude/plans/flock-nested-shared-structure-plan.md §5). Runs against LIVE ORS, no golden touch.
//
// The single riskiest assumption: that a cap-keyed tier for a COMMUTE-DOMINATED runner (jim's Jimmy)
//   (a) builds a non-degenerate VALIDATED return-to-base lap on a FAR café in a real street grid, and
//   (b) leaves that runner a feasible egress home within their remaining cap.
// Also surfaces the panel's predicted failure mode: the engine keys reaches on a CROW estimate
// (×ROAD_FACTOR), which for a far café is pessimistic and can fall below MIN_GROW_KM (1.5) so no tier
// ever builds — in which case nesting is an AUTO/near-home win only and jim keeps the patches.
//   npx tsx scripts/_nest_probe.ts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
process.env.FLOCK_LOG_LEVEL ??= "warn";
import { distanceMeters } from "../src/lib/geo";
import { getRoute } from "../src/lib/ors";
import { buildBackbone } from "../src/lib/flockRoute";
import type { LatLng, FlockWaypoint } from "../src/lib/types";

const ROAD_FACTOR = 1.3;
const MIN_GROW_KM = 1.5;
const RETURN_TOL_M = 120; // ROSETTE_RETURN_TOL_M
const CAP_GRACE = 0.4;
const f2 = (n: number) => n.toFixed(2);
const crowKm = (a: LatLng, b: LatLng) => distanceMeters(a, b) / 1000;
const realKm = async (a: LatLng, b: LatLng) => (await getRoute([a, b])).distanceKm;

// jim geometry (post-recalibration): far café, clustered homes, Jimmy commute-dominated (cap 17.5).
const cafe: LatLng = { lat: -37.755, lng: 145.015 };
const jimmy: LatLng = { lat: -37.798, lng: 144.97 };
const anchor: LatLng = { lat: -37.801, lng: 144.969 };
const mae: LatLng = { lat: -37.795, lng: 144.972 };
const JIMMY_CAP = 17.5;
const wp = (ll: LatLng): FlockWaypoint => ({ id: "c", location: ll, address: "Cafe", name: "Cafe", stopMinutes: 0 });

// Does the built backbone contain a VALIDATED return-to-base vertex near arc `wantKm` (i.e. a tier
// boundary the rosette would export)? Returns the arc-km of the closest such vertex, or null.
function tierBoundaryNear(coords: LatLng[], cumKm: number[], center: LatLng, wantKm: number): number | null {
  let bestKm: number | null = null;
  let bestD = Infinity;
  for (let i = 1; i < coords.length - 1; i++) {
    if (Math.abs(cumKm[i] - wantKm) > 2) continue; // ROSETTE_RETURN_WINDOW_KM
    const d = distanceMeters(coords[i], center);
    if (d <= RETURN_TOL_M && d < bestD) {
      bestD = d;
      bestKm = cumKm[i];
    }
  }
  return bestKm;
}

async function main() {
  console.log("── NEST PROBE (jim far-café, Jimmy cap 17.5) ──\n");
  const oneWayCrow = crowKm(jimmy, cafe);
  const oneWayReal = await realKm(jimmy, cafe);
  const commuteRoad = ROAD_FACTOR * 2 * oneWayCrow; // what arcEstimate(Cap) would compute
  const commuteReal = oneWayReal + (await realKm(cafe, jimmy));
  const reachCrow = JIMMY_CAP - commuteRoad; // the engine's cap-keyed reach (arcEstimateCap)
  const reachReal = JIMMY_CAP - commuteReal; // the geometry's true affordable lap

  console.log(`Jimmy home→café: crow ${f2(oneWayCrow)}km · real ${f2(oneWayReal)}km`);
  console.log(`Jimmy round-trip commute: crow×1.3 ${f2(commuteRoad)}km · real ${f2(commuteReal)}km`);
  console.log(`Jimmy cap-keyed reach (the lap he can afford): crow ${f2(reachCrow)}km · real ${f2(reachReal)}km`);
  console.log(`MIN_GROW_KM (rosette lap floor) = ${MIN_GROW_KM}\n`);

  // STEP 2 — is the cap-keyed reach non-zero AND above the rosette lap floor?
  const crowAboveFloor = reachCrow > MIN_GROW_KM;
  console.log(`[2] cap-keyed reach non-zero? crow ${reachCrow > 0 ? "YES" : "NO"} (${f2(reachCrow)})  ·  above MIN_GROW? ${crowAboveFloor ? "YES" : "NO ← engine would build NO tier (crow pessimism)"}`);

  // STEP 3 — does buildBackbone build a validated café lap? Test BOTH the engine's crow reach and the
  // real-ORS reach (to separate "geometry can't close" from "estimator too pessimistic").
  const targetKm = Math.max(reachReal + 2.5, 5); // an outer lap for the keen, so a 2-tier rosette can form
  const starts = [jimmy, anchor, mae];
  const finishes = [jimmy, anchor, mae];
  let crowTier: number | null = null;
  let realTier: number | null = null;
  if (crowAboveFloor) {
    const bb = await buildBackbone({ waypoints: [wp(cafe)], starts, targetKm, reaches: [reachCrow], finishes });
    crowTier = tierBoundaryNear(bb.coords, bb.cumKm, bb.coords[0], reachCrow);
  }
  if (reachReal > MIN_GROW_KM) {
    const bb = await buildBackbone({ waypoints: [wp(cafe)], starts, targetKm, reaches: [reachReal], finishes });
    realTier = tierBoundaryNear(bb.coords, bb.cumKm, bb.coords[0], reachReal);
  }
  console.log(`[3] validated café lap builds (return-to-base ≤120m near the reach)?`);
  console.log(`      from crow reach: ${crowAboveFloor ? (crowTier != null ? `YES @ arc ${f2(crowTier)}km` : "NO (no validated return vertex)") : "skipped (below floor)"}`);
  console.log(`      from real reach: ${reachReal > MIN_GROW_KM ? (realTier != null ? `YES @ arc ${f2(realTier)}km` : "NO (lap didn't close post-de-spur)") : "skipped (below floor)"}`);

  // STEP 4 — full-member feasibility: home→café + lap + café→home ≤ cap + grace (lap returns to café).
  const tier = crowTier ?? realTier;
  if (tier != null) {
    const total = commuteReal + tier; // the lap is at the café; commute is the real round-trip
    console.log(`\n[4] Jimmy full-member of S1 (commute ${f2(commuteReal)} + lap ${f2(tier)}) = ${f2(total)}km  ≤ cap+grace ${f2(JIMMY_CAP + CAP_GRACE)}? ${total <= JIMMY_CAP + CAP_GRACE ? "YES ✅" : "NO ❌ (busts cap)"}`);
  } else {
    console.log(`\n[4] skipped — no tier built.`);
  }

  // DECISION
  console.log("\n── DECISION ──");
  if (crowTier != null && (commuteReal + crowTier) <= JIMMY_CAP + CAP_GRACE) {
    console.log("✅ FULL PASS — the engine's cap-keyed reach builds a feasible far-café tier. Stages 2–5 unlocked: jim can go green via tier+rescue.");
  } else if (realTier != null) {
    console.log("⚠️  GEOMETRY OK but ESTIMATOR PESSIMISTIC — a validated lap closes for the REAL reach, but the crow×1.3 cap-keyed estimate is below MIN_GROW so the engine builds no tier.");
    console.log("    → The tier mechanism needs a real-ORS (not crow) reach for far-café commute-dominated runners, OR jim stays on fairness-sizing+rescue and nesting is the AUTO/near-home + Stage-4-frontier win.");
  } else {
    console.log("❌ FALLBACK — no validated far-café tier builds for jim. Nesting is an AUTO/near-home seating improvement only (tier/ros/swr); jim keeps fairness-sizing+rescue. Do NOT thread far-café tiers through the pipeline.");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
