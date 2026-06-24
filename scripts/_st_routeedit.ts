// Route-edit test — CATEGORY: drag-to-insert-waypoint ordering.
//
// insertionIndex decides WHERE a waypoint dragged off the shared spine splices into
// the ordered waypoint list. Order is load-bearing: the corridor routes through
// session.waypoints in array order, so a mid-route grab must land between its
// neighbours (not append, which detours the route out-and-back).
//
// Run: npx tsx scripts/_st_routeedit.ts

import { insertionIndex } from "../src/lib/routeEdit";
import type { LatLng } from "../src/lib/types";

let _pass = 0;
const _fails: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) { _pass++; console.log(`  ✓ ${msg}`); }
  else { _fails.push(msg); console.log(`  ✗ FAIL  ${msg}`); }
}
function suite(n: string) { console.log(`\n══ ${n} ══`); }

// A simple west→east spine at a fixed latitude; along-route position ↔ longitude.
const lat = -37.81;
const spine: LatLng[] = [];
for (let i = 0; i <= 100; i++) spine.push({ lat, lng: 144.90 + (i / 100) * 0.20 }); // 144.90 → 145.10
const wp = (lng: number): { location: LatLng } => ({ location: { lat, lng } });

function main() {
  suite("insertionIndex — splice in along-route order");
  {
    // Existing waypoints at lng .94, .98, 1.02 (already in order along the spine).
    const waypoints = [wp(144.94), wp(144.98), wp(145.02)];

    ok(insertionIndex(spine, waypoints, { lat, lng: 144.92 }) === 0, "grab before all → index 0");
    ok(insertionIndex(spine, waypoints, { lat, lng: 144.96 }) === 1, "grab between wp0 and wp1 → index 1");
    ok(insertionIndex(spine, waypoints, { lat, lng: 145.00 }) === 2, "grab between wp1 and wp2 → index 2");
    ok(insertionIndex(spine, waypoints, { lat, lng: 145.06 }) === 3, "grab after all → index 3 (append)");

    ok(insertionIndex(spine, [], { lat, lng: 145.00 }) === 0, "no existing waypoints → index 0");
    ok(insertionIndex([], waypoints, { lat, lng: 145.0 }) === waypoints.length, "degenerate spine (<2 pts) → append");

    // A point slightly off the line still orders by its projection along the spine.
    ok(insertionIndex(spine, waypoints, { lat: lat + 0.01, lng: 144.96 }) === 1, "off-line grab orders by projection");
  }

  console.log(`\n${_fails.length === 0 ? "✅ ALL PASS" : `❌ ${_fails.length} FAILED`}  (${_pass}/${_pass + _fails.length})`);
  if (_fails.length) { for (const f of _fails) console.log("  · " + f); }
  process.exit(_fails.length ? 1 : 0);
}

main();
