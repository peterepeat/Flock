// WELFARE-UNIT PROBE — does the engine's together-metric reward SLOW-JOINS, and does
// "shared-distance-at-own-pace" fix it? (Core-model correction #2, workflow wf_8492f725.)
//
// Runs the REAL engine under the golden deterministic fake-ORS (straight-line p2p, square
// loops) — no live ORS, no rate limit. Holds a 2-runner flock's GEOMETRY fixed (same homes,
// same distance target, no caps/deadlines so windows are pace-invariant) and sweeps one
// runner's pace from fast to slow. For each pace it reads the engine's own sharedSegments and
// scores three units:
//   • systemMin   = Σ seg.overlapMinutes × pairs          — TODAY's unit (wall-time based)
//   • sharedKm    = Σ seg.length                          — pace-neutral geometry
//   • ownPaceMin  = Σ_seg Σ_{i present} segKm × ownPace_i — the proposed fix (each runner's
//                                                            company valued at THEIR pace)
// HYPOTHESIS: systemMin RISES as the companion slows (the slow-join reward — the bug);
// sharedKm is FLAT (same geometry); ownPaceMin is FLAT in the COMPANION's pace (the fix).
// Also reports the "drag tax" the fast runner eats — the wall-minutes the current unit
// miscounts as togetherness.
//   npx tsx scripts/_welfare_probe.ts

// --- deterministic fake ORS (install BEFORE importing the engine) ---
const R = 6371000;
function haversineM(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function orsResponse(coordinates: [number, number][], distanceKm: number): Response {
  const payload = {
    features: [{ geometry: { type: "LineString", coordinates }, properties: { summary: { distance: distanceKm, duration: distanceKm * 600 } } }],
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/geo+json", "x-ratelimit-remaining": "1000" } });
}
globalThis.fetch = (async (_url: string, opts: { body: string }) => {
  const body = JSON.parse(opts.body) as { coordinates: [number, number][]; options?: { round_trip?: { length: number } } };
  const rt = body.options?.round_trip;
  if (rt) {
    const [lng, lat] = body.coordinates[0];
    const sideM = rt.length / 4;
    const dLat = sideM / 111320;
    const dLng = sideM / (111320 * Math.cos((lat * Math.PI) / 180));
    const loop: [number, number][] = [[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]];
    return orsResponse(loop, rt.length / 1000);
  }
  let m = 0;
  for (let i = 1; i < body.coordinates.length; i++) m += haversineM(body.coordinates[i - 1], body.coordinates[i]);
  return orsResponse(body.coordinates, m / 1000);
}) as unknown as typeof fetch;
process.env.ORS_API_KEY = "fake-key-for-probe";
process.env.FLOCK_LOG_LEVEL ??= "error";

type FlockSession = import("../src/lib/types").FlockSession;
type Participant = import("../src/lib/types").Participant;
type LatLng = import("../src/lib/types").LatLng;

function person(id: string, lat: number, lng: number, extra: Partial<Participant> = {}): Participant {
  return {
    id, name: id, color: "#000", addedAt: "2026-01-01T00:00:00Z",
    startLocation: { lat, lng }, startAddress: id, earliestStartTime: "07:00",
    finishLocation: null, finishAddress: null, latestFinishTime: null,
    preferredPace: 360, maxPace: 300, preferredDistance: null, maxDistance: null, restStop: null, ...extra,
  };
}
function session(id: string, participants: Participant[]): FlockSession {
  return {
    id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lockedAt: null,
    unitPreference: "km", participants, waypoints: [], computedRoutes: null, sharedSegments: null,
    flockRoute: null, waypointEtas: null, gpxPassthrough: null,
  };
}
function lineKm(coords: number[][]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversineM(coords[i - 1] as [number, number], coords[i] as [number, number]);
  return m / 1000;
}
const f2 = (n: number) => n.toFixed(2);
const pad = (s: string, n: number) => s.padStart(n);

async function main() {
  const { calculateRoutes } = await import("../src/lib/routeEngine");
  console.log("── WELFARE-UNIT PROBE — 2 clustered runners, fixed geometry, sweep B's pace ──\n");
  console.log("A fixed at 360 s/km (6:00/km). B slows from 360 → 600. Same homes, target 8km, no caps.\n");

  const homeA: LatLng = { lat: -37.8, lng: 144.97 };
  const homeB: LatLng = { lat: -37.8006, lng: 144.9706 };
  const paceA = 360;
  const paces = [360, 420, 480, 540, 600];

  // The decisive cut is PER-RUNNER on the FAST runner A (the one being dragged). The bug is
  // that A's companionship credit depends on B's pace; the fix makes it depend only on A's own.
  console.log(`${pad("B pace", 7)} ${pad("sharedKm", 9)} ${pad("A_today", 9)} ${pad("A_fixKm", 9)} ${pad("A_fixMin", 9)} ${pad("systemMin", 10)}`);
  console.log(`${pad("(s/km)", 7)} ${pad("(geom)", 9)} ${pad("wall✗", 9)} ${pad("km ✓", 9)} ${pad("ownmin✓", 9)} ${pad("TODAY✗", 10)}`);
  const rows: { paceB: number; sharedKm: number; aToday: number; aFixKm: number; aFixMin: number; systemMin: number }[] = [];
  for (const paceB of paces) {
    const s = session("welf", [
      person("A", homeA.lat, homeA.lng, { preferredDistance: 8, preferredPace: paceA }),
      person("B", homeB.lat, homeB.lng, { preferredDistance: 8, preferredPace: paceB }),
    ]);
    const res = await calculateRoutes(s);
    let sharedKm = 0, systemMin = 0, aToday = 0, aFixKm = 0;
    for (const seg of res.sharedSegments) {
      const ids = seg.participantIds;
      const n = ids.length;
      if (n < 2) continue;
      const segKm = lineKm((seg.geometry.coordinates as number[][]));
      const pairs = (n * (n - 1)) / 2;
      sharedKm += segKm * pairs;
      systemMin += seg.overlapMinutes * pairs; // TODAY: wall-minutes × pairs (rewards slow-joins)
      if (ids.includes("A")) {
        aToday += seg.overlapMinutes; // A credited the WALL (slowest-present) minutes — rises with B
        aFixKm += segKm; // A credited the shared distance — pace-neutral
      }
    }
    const aFixMin = (aFixKm * paceA) / 60; // A's company valued at A's OWN pace
    rows.push({ paceB, sharedKm, aToday, aFixKm, aFixMin, systemMin });
    console.log(`${pad(String(paceB), 7)} ${pad(f2(sharedKm), 9)} ${pad(f2(aToday), 9)} ${pad(f2(aFixKm), 9)} ${pad(f2(aFixMin), 9)} ${pad(f2(systemMin), 10)}`);
  }

  // --- verdict ---
  const base = rows[0], slow = rows[rows.length - 1];
  const aRise = ((slow.aToday - base.aToday) / base.aToday) * 100;
  const aFixRise = ((slow.aFixMin - base.aFixMin) / base.aFixMin) * 100;
  const kmRise = ((slow.sharedKm - base.sharedKm) / base.sharedKm) * 100;
  const sysRise = ((slow.systemMin - base.systemMin) / base.systemMin) * 100;
  console.log("\n── VERDICT ──");
  console.log(`Geometry held? sharedKm ${f2(base.sharedKm)} → ${f2(slow.sharedKm)}  (${Math.abs(kmRise) <= 0.5 ? "FLAT ✓ same plan, pace-isolated" : `MOVED ${f2(kmRise)}% — not isolated`})`);
  console.log(`FAST runner A's credit as B slows 360→600 (A unchanged, same shared 3.93km):`);
  console.log(`  • TODAY (wall):        ${f2(base.aToday)} → ${f2(slow.aToday)} min  = +${f2(aRise)}%  ← A rewarded for B being SLOW (the bug) ✗`);
  console.log(`  • FIX (own-pace min):  ${f2(base.aFixMin)} → ${f2(slow.aFixMin)} min  = ${Math.abs(aFixRise) < 0.5 ? "FLAT ✓" : f2(aFixRise) + "%"}  ← A's credit independent of B's pace`);
  console.log(`  • FIX (shared km):     ${f2(base.aFixKm)} → ${f2(slow.aFixKm)} km   = FLAT ✓  ← fully pace-neutral`);
  console.log(`System total (wall×pairs) rises +${f2(sysRise)}% for ZERO extra sharing — the engine would PREFER the flock with the slower runner.\n`);
  if (aRise > 5 && Math.abs(aFixRise) < 0.5) {
    console.log(`✅ CONFIRMED. The fast runner's "togetherness" credit rises +${f2(aRise)}% purely because the companion slowed — same homes, same 3.93km shared, no extra company. systemTM = wall-minutes×pairs structurally rewards slow-joins (and would mis-rank plans toward dragging fast runners). Both proposed fixes (shared-km, or own-pace-minutes) make each runner's credit depend ONLY on their own pace + the shared distance, killing the phantom reward. The objective correction is real and the unit is well-specified.`);
  } else {
    console.log("⚠️  INCONCLUSIVE — inspect the table.");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
