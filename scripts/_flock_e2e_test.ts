// End-to-end test for the social-first engine: buildRoute (ORS) → planRun → projectPlan.
// Deterministic fake-ORS (straight-line p2p, square loops) so it's a pure regression guard;
// proves the route → plan → CalcResult pipe produces a well-formed render contract.
//   npx tsx scripts/_flock_e2e_test.ts

// --- fake ORS (install before importing the engine) ---
const R = 6371000;
function hav(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function ors(coords: [number, number][], distanceKm: number): Response {
  return new Response(
    JSON.stringify({ features: [{ geometry: { type: "LineString", coordinates: coords }, properties: { summary: { distance: distanceKm, duration: distanceKm * 600 } } }] }),
    { status: 200, headers: { "content-type": "application/geo+json", "x-ratelimit-remaining": "1000" } },
  );
}
globalThis.fetch = (async (_u: string, opts: { body: string }) => {
  const body = JSON.parse(opts.body) as { coordinates: [number, number][]; options?: { round_trip?: { length: number } } };
  const rt = body.options?.round_trip;
  if (rt) {
    const [lng, lat] = body.coordinates[0];
    const s = rt.length / 4;
    const dLat = s / 111320;
    const dLng = s / (111320 * Math.cos((lat * Math.PI) / 180));
    return ors([[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]], rt.length / 1000);
  }
  let m = 0;
  for (let i = 1; i < body.coordinates.length; i++) m += hav(body.coordinates[i - 1], body.coordinates[i]);
  return ors(body.coordinates, m / 1000);
}) as unknown as typeof fetch;
process.env.ORS_API_KEY = "fake";
process.env.FLOCK_LOG_LEVEL ??= "error";

import { buildRoute } from "../src/lib/flock/route";
import { planRun } from "../src/lib/flock/plan";
import { projectPlan } from "../src/lib/flock/project";
import type { Runner } from "../src/lib/flock/model";
import type { LatLng } from "../src/lib/types";

let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${m}`); if (!c) failures++; };
const free = { kind: "free" as const };

async function main() {
  console.log("── FLOCK ENGINE E2E — buildRoute → planRun → projectPlan ──\n");
  const wps = [
    { id: "w1", location: { lat: -37.8, lng: 144.96 } as LatLng, name: "Start", stopMinutes: 0 },
    { id: "w2", location: { lat: -37.8, lng: 145.0 } as LatLng, name: "Café", stopMinutes: 15 },
    { id: "w3", location: { lat: -37.8, lng: 145.04 } as LatLng, name: "Park", stopMinutes: 0 },
  ];
  const route = await buildRoute({ waypoints: wps, targetKm: null });
  console.log(`route built: ${route.totalKm.toFixed(2)} km, ${route.stops.length} stop(s) @ ${route.stops.map((s) => s.km.toFixed(1)).join(",")} km`);
  ok(route.totalKm > 5, "route has real length (waypoint tour)");
  ok(route.stops.length === 1 && Math.abs(route.stops[0].durationSec - 900) < 1, "café stop snapped with 15 min dwell");

  const runners: Runner[] = [
    { id: "A", pace: 360, enter: free, exit: free, maxDistanceKm: null, earliestSec: null, latestSec: null, connectorKm: 0 },
    { id: "B", pace: 420, enter: free, exit: free, maxDistanceKm: null, earliestSec: null, latestSec: null, connectorKm: 0 },
    { id: "C", pace: 360, enter: free, exit: free, maxDistanceKm: route.totalKm * 0.6, earliestSec: null, latestSec: null, connectorKm: 0 },
  ];
  const plan = planRun({ route, runners, t0Sec: 7 * 3600 });
  const result = projectPlan({ plan, route, runners, waypoints: wps });

  ok(result.routes.length === 3, "a ComputedRoute per runner");
  ok(result.routes.every((r) => (r.geometry.coordinates?.length ?? 0) >= 2), "every route has drawable geometry");
  ok(result.routes.every((r) => r.schedule.length > 0 && r.departureTime && r.arrivalTime), "every route has a timed schedule");
  ok(result.sharedSegments.length > 0, `shared segments produced (${result.sharedSegments.length})`);
  ok(result.sharedSegments.every((s) => s.participantIds.length >= 2), "every shared segment has ≥2 participants");
  ok(result.sharedSegments.some((s) => s.isConvergence), "at least one convergence (the gather)");
  ok(!!result.waypointEtas && Object.keys(result.waypointEtas).length >= 2, "waypoint ETAs computed");
  ok(result.summary.totalTogetherMinutes > 0, `together-time in summary (${result.summary.totalTogetherMinutes} wall-min)`);
  ok(result.summary.pairwiseSummary.length === 3, "pairwise summary covers all 3 pairs");
  // C shares the café: a rest segment with companions appears in C's schedule.
  const cRest = result.routes.find((r) => r.participantId === "C")!.schedule.find((s) => s.type === "rest");
  ok(!!cRest && cRest.companionIds.length >= 1, "capped C shares the café dwell (rest leg with companions)");
  ok(!!result.flockRoute && result.flockRoute.coordinates.length >= 2, "flock spine present");

  console.log("\n" + (failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
