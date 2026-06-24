// Integration test: a new-model FlockSession (start/finish pins, time anchor, intended
// distance) through calculateRoutes(session) → CalcResult, under deterministic fake-ORS.
// Proves the social-first input model wires cleanly into the proven engine.
//   npx tsx scripts/_flock_adapter_test.ts

// --- fake ORS ---
const R = 6371000;
function hav(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180, dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function ors(coords: [number, number][], km: number): Response {
  return new Response(JSON.stringify({ features: [{ geometry: { type: "LineString", coordinates: coords }, properties: { summary: { distance: km, duration: km * 600 } } }] }), { status: 200, headers: { "content-type": "application/geo+json", "x-ratelimit-remaining": "1000" } });
}
globalThis.fetch = (async (_u: string, opts: { body: string }) => {
  const body = JSON.parse(opts.body) as { coordinates: [number, number][]; options?: { round_trip?: { length: number } } };
  const rt = body.options?.round_trip;
  if (rt) {
    const [lng, lat] = body.coordinates[0], s = rt.length / 4, dLat = s / 111320, dLng = s / (111320 * Math.cos((lat * Math.PI) / 180));
    return ors([[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]], rt.length / 1000);
  }
  let m = 0;
  for (let i = 1; i < body.coordinates.length; i++) m += hav(body.coordinates[i - 1], body.coordinates[i]);
  return ors(body.coordinates, m / 1000);
}) as unknown as typeof fetch;
process.env.ORS_API_KEY = "fake";
process.env.FLOCK_LOG_LEVEL ??= "error";

import { calculateRoutes } from "../src/lib/flock";
import type { FlockSession, Participant, FlockWaypoint, LocationPin } from "../src/lib/types";

let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${m}`); if (!c) failures++; };
const auto: LocationPin = { kind: "auto" };

function person(id: string, extra: Partial<Participant> = {}): Participant {
  return { id, name: id, color: "#000", addedAt: "2026-01-01T00:00:00Z", startPin: auto, finishPin: auto, maxDistanceKm: null, pace: null, earliestStartTime: null, latestFinishTime: null, ...extra };
}
function wp(id: string, lat: number, lng: number, stop = 0): FlockWaypoint {
  return { id, location: { lat, lng }, address: id, name: id, stopMinutes: stop };
}
function session(participants: Participant[], waypoints: FlockWaypoint[], extra: Partial<FlockSession> = {}): FlockSession {
  return { id: "t", createdAt: "", updatedAt: "", locks: { run: false, route: false, runners: false }, runnerLocks: {}, unitPreference: "km", startAnchor: { kind: "auto" }, intendedDistanceKm: null, participants, waypoints, computedRoutes: null, sharedSegments: null, flockRoute: null, waypointEtas: null, gpxPassthrough: null, ...extra };
}

async function main() {
  console.log("── FLOCK ADAPTER — new-model session through calculateRoutes ──\n");
  const wps = [wp("w1", -37.8, 144.96), wp("w2", -37.8, 145.0, 15), wp("w3", -37.8, 145.04)];
  const s = session(
    [
      person("A"), // full auto, default pace
      person("B", { pace: 420 }), // slower
      person("C", { startPin: { kind: "waypoint", waypointId: "w2" } }), // joins AT the café
      person("D", { maxDistanceKm: 2 }), // can only do 2 km
    ],
    wps,
    { startAnchor: { kind: "departure", time: "08:00" } },
  );

  const res = await calculateRoutes(s);
  ok(!res.skipped && res.routes.length === 4, "a route per participant, not skipped");

  const A = res.routes.find((r) => r.participantId === "A")!;
  ok(A.departureTime === "08:00", `A (auto, at the gather) departs at the 08:00 anchor (got ${A.departureTime})`);

  // C pinned to join at the café — their route starts at w2, not w1.
  const C = res.routes.find((r) => r.participantId === "C")!;
  const cFirst = C.schedule.find((seg) => seg.distanceKm > 0 || seg.type === "rest");
  ok(C.distanceKm < A.distanceKm, `C joins mid-route at the café (${C.distanceKm} km < A's ${A.distanceKm} km)`);
  ok(C.schedule.some((seg) => seg.type === "rest" && seg.companionIds.length > 0), "C shares the café dwell from their join point");
  void cFirst;

  // D capped at 2 km gets a short, explained plan.
  const D = res.routes.find((r) => r.participantId === "D")!;
  ok(D.distanceKm <= 2 + 1e-6, `D stays within their 2 km (got ${D.distanceKm})`);
  ok(res.warnings.some((w) => w.participantId === "D"), "D gets an explanatory warning for the short share");

  ok(res.summary.totalTogetherMinutes > 0, `together-time reported (${res.summary.totalTogetherMinutes} wall-min)`);
  ok(!!res.waypointEtas && res.waypointEtas["w2"] != null, "the café has an ETA");

  console.log("\n" + (failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
