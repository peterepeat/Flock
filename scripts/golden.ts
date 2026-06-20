// Golden-snapshot test for the route engine — the repo's deterministic regression
// guard. Stubs `fetch` with a DETERMINISTIC fake ORS (straight-line p2p, clean square
// loops) so calculateRoutes produces byte-identical output every run, then compares a
// set of fixed sessions against scripts/golden.json. This guards the optimizer /
// strand / enforce logic (what Stage 2's priced budgets touch); the ORS-dependent
// geometry (F/D firing) is covered by scripts/scenarios.sh against real ORS.
//
//   npx --yes tsx scripts/golden.ts            # check (fails on any drift)
//   npx --yes tsx scripts/golden.ts --update   # regenerate the golden
//
// Determinism: fixtures carry fixed participant/waypoint ids; the fake ORS is a pure
// function of the request, so the engine output depends only on the fixture.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// --- deterministic fake ORS (install BEFORE importing the engine) ------------
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
    features: [
      {
        geometry: { type: "LineString", coordinates },
        properties: { summary: { distance: distanceKm, duration: distanceKm * 600 } },
      },
    ],
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/geo+json", "x-ratelimit-remaining": "1000" },
  });
}
globalThis.fetch = (async (_url: string, opts: { body: string }) => {
  const body = JSON.parse(opts.body) as {
    coordinates: [number, number][];
    options?: { round_trip?: { length: number } };
  };
  const rt = body.options?.round_trip;
  if (rt) {
    // A clean square loop of the requested perimeter around the start (no spurs, so
    // despur leaves it; encloses area, so it survives the area test).
    const [lng, lat] = body.coordinates[0];
    const sideM = rt.length / 4;
    const dLat = sideM / 111320;
    const dLng = sideM / (111320 * Math.cos((lat * Math.PI) / 180));
    const loop: [number, number][] = [
      [lng, lat],
      [lng + dLng, lat],
      [lng + dLng, lat + dLat],
      [lng, lat + dLat],
      [lng, lat],
    ];
    return orsResponse(loop, rt.length / 1000);
  }
  // p2p through the ordered coordinates: straight segments, crow distance.
  let m = 0;
  for (let i = 1; i < body.coordinates.length; i++) m += haversineM(body.coordinates[i - 1], body.coordinates[i]);
  return orsResponse(body.coordinates, m / 1000);
}) as unknown as typeof fetch;

process.env.ORS_API_KEY = "fake-key-for-golden";

type FlockSession = import("../src/lib/types").FlockSession;
type Participant = import("../src/lib/types").Participant;
type FlockWaypoint = import("../src/lib/types").FlockWaypoint;

// --- fixtures ----------------------------------------------------------------
function person(id: string, lat: number, lng: number, extra: Partial<Participant> = {}): Participant {
  return {
    id,
    name: id,
    color: "#000",
    addedAt: "2026-01-01T00:00:00Z",
    startLocation: { lat, lng },
    startAddress: id,
    earliestStartTime: "07:00",
    finishLocation: null,
    finishAddress: null,
    latestFinishTime: null,
    preferredPace: 360,
    maxPace: 300,
    preferredDistance: null,
    maxDistance: null,
    restStop: null,
    ...extra,
  };
}
function wp(id: string, lat: number, lng: number, stopMinutes = 0): FlockWaypoint {
  return { id, location: { lat, lng }, address: id, name: id, stopMinutes };
}
function session(id: string, participants: Participant[], waypoints: FlockWaypoint[] = []): FlockSession {
  return {
    id,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lockedAt: null,
    unitPreference: "km",
    participants,
    waypoints,
    computedRoutes: null,
    sharedSegments: null,
    flockRoute: null,
    waypointEtas: null,
    gpxPassthrough: null,
  };
}

const FIXTURES: Record<string, FlockSession> = {
  // solo with a distance target (window + solo-fill paths)
  g1_solo: session("g1", [person("solo", -37.8, 144.967, { preferredDistance: 8, maxDistance: 9 })]),
  // two runners, caps + one deadline (optimizeWindows best-response + enforce + strand)
  g2_pair: session("g2", [
    person("anchor", -37.81, 144.969),
    person("capped", -37.824, 145.0, { preferredDistance: 10, maxDistance: 11, latestFinishTime: "08:15" }),
  ]),
  // three clustered + waypoints + a stop (legs, dwell, ETAs)
  g3_wp_stop: session(
    "g3",
    [
      person("a", -37.798, 144.9775),
      person("b", -37.7985, 144.9785, { preferredDistance: 12, maxDistance: 14 }),
      person("c", -37.799, 144.978, { preferredDistance: 9, maxDistance: 10 }),
    ],
    [wp("w1", -37.798, 144.978), wp("w2", -37.805, 144.972, 15), wp("w3", -37.784, 144.961)],
  ),
  // a far runner that should strand to a solo loop
  g4_strand: session("g4", [
    person("near", -37.8, 144.967, { preferredDistance: 8, maxDistance: 9 }),
    person("far", -37.86, 145.06, { preferredDistance: 5, maxDistance: 6, latestFinishTime: "07:45" }),
  ]),
  // ZERO HEADROOM (softness=0): max == preferred for both, so the Stage 2 priced
  // relaxation must NOT fire — this fixture MUST stay byte-identical through pricing.
  g6_tight: session(
    "g6",
    [
      person("t1", -37.798, 144.9775, { preferredDistance: 10, maxDistance: 10 }),
      person("t2", -37.7985, 144.9785, { preferredDistance: 8, maxDistance: 8 }),
    ],
    [wp("w1", -37.798, 144.978), wp("w2", -37.789, 144.995)],
  ),
  // SINGLE waypoint with a stop → a loop based at the waypoint (the "meet at one café,
  // run a loop" case). Exercises the Phase-B path for waypoints.length===1 AND BOTH Stage 1
  // FORCED tiers: the two distinct homes share no tail (natural F/D can't fire), but with one
  // café every runner is a merge candidate, so forced F synthesises a meeting point P on the
  // way IN and forced D mirrors it on the way HOME (homes==finishes ⇒ the same P, so the spine
  // runs P→café→loop→café→P). This snapshot pins that FIRED output byte-identical (the
  // deterministic regression guard for forced convergence + dispersal).
  g7_single_wp: session(
    "g7",
    [
      person("s1", -37.806, 144.969),
      person("s2", -37.781, 144.986, { preferredDistance: 12, maxDistance: 14 }),
    ],
    [wp("w1", -37.8284, 144.9847, 20)],
  ),
  // TWO stop-waypoints at the SAME spot → their dwells must SUM (10+15=25 min), not drop
  // one. Guards the computeLegs .filter fix.
  g8_dup_stop: session(
    "g8",
    [person("d1", -37.798, 144.9775), person("d2", -37.7985, 144.9785, { preferredDistance: 12, maxDistance: 14 })],
    [wp("w1", -37.798, 144.978), wp("w2", -37.805, 144.972, 10), wp("w3", -37.805, 144.972, 15)],
  ),
  // finish-elsewhere keen runner (corridor egress)
  g5_finish: session(
    "g5",
    [
      person("ava", -37.798, 144.9775, {
        preferredDistance: 14,
        maxDistance: 16,
        finishLocation: { lat: -37.81, lng: 145.01 },
        finishAddress: "finish",
      }),
      person("ben", -37.7985, 144.9785, { preferredDistance: 12, maxDistance: 14 }),
    ],
    [wp("w1", -37.798, 144.978), wp("w2", -37.789, 144.995)],
  ),
};

// --- normalise + compare -----------------------------------------------------
// Round every number to 4 dp so float jitter never trips the diff.
function norm(v: unknown): unknown {
  if (typeof v === "number") return Math.round(v * 1e4) / 1e4;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = norm((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export { FIXTURES };

const GOLDEN_PATH = join(process.cwd(), "scripts", "golden.json");

async function main() {
  // Import AFTER the fetch stub is installed.
  const { calculateRoutes } = await import("../src/lib/routeEngine");
  const update = process.argv.includes("--update");

  const results: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(FIXTURES)) {
    results[name] = norm(await calculateRoutes(s));
  }
  const actual = JSON.stringify(results, null, 2);

  if (update) {
    writeFileSync(GOLDEN_PATH, actual + "\n");
    console.log(`golden updated → ${GOLDEN_PATH} (${Object.keys(FIXTURES).length} fixtures)`);
    return 0;
  }
  if (!existsSync(GOLDEN_PATH)) {
    console.error("no golden.json — run with --update first");
    return 2;
  }
  const expected = readFileSync(GOLDEN_PATH, "utf8").trimEnd();
  if (actual === expected.trimEnd()) {
    console.log(`golden OK — ${Object.keys(FIXTURES).length} fixtures byte-identical`);
    return 0;
  }
  // Show the differing fixtures for a readable failure.
  const exp = JSON.parse(expected) as Record<string, unknown>;
  for (const name of Object.keys(FIXTURES)) {
    const a = JSON.stringify(results[name]);
    const e = JSON.stringify(exp[name]);
    if (a !== e) {
      console.error(`GOLDEN DRIFT in fixture "${name}":`);
      console.error("  expected:", e.slice(0, 400));
      console.error("  actual:  ", a.slice(0, 400));
    }
  }
  return 1;
}

declare const require: { main?: unknown };
declare const module: unknown;
if (typeof require === "undefined" || require.main === module) {
  main().then((code) => process.exit(code));
}
