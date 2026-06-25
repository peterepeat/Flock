// Dev seeding: run the REAL engine (via the harness's deterministic fake-ORS) and write
// fully-computed FlockSessions to the local file store (.flock-data/flock-<id>.json) so the
// browser renders my engine output WITHOUT a live ORS key (the prod key is encrypted/unpullable).
// The client only recalculates when computedRoutes === null, so a seeded session renders as-is.
//   npx tsx scripts/_seed_dev.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { calculateRoutes, person, wp, session, atPlace, atWp } from "./_st_harness";
import type { FlockSession } from "../src/lib/types";

const PALETTE = ["#E4572E", "#2E86AB", "#28A745", "#A23B72", "#F18F01", "#5C4D7D"];

async function seed(id: string, s: FlockSession) {
  // colour the participants from the palette (the harness leaves them black)
  s.participants.forEach((p, i) => { p.color = PALETTE[i % PALETTE.length]; p.name = p.id; });
  const res = await calculateRoutes(s);
  const out: FlockSession = {
    ...s,
    id,
    createdAt: "2026-06-22T00:00:00Z",
    updatedAt: "2026-06-22T00:00:00Z",
    computedRoutes: res.routes,
    sharedSegments: res.sharedSegments,
    flockRoute: res.flockRoute,
    waypointEtas: res.waypointEtas,
  };
  const dir = path.join(process.cwd(), ".flock-data");
  await fs.mkdir(dir, { recursive: true });
  const env = { session: out, tokens: {}, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
  await fs.writeFile(path.join(dir, `flock-${id}.json`), JSON.stringify(env, null, 2), "utf8");
  console.log(`seeded /flock/${id}  — ${res.routes.length} runners, together=${res.summary.totalTogetherMinutes}m, warnings=${res.warnings.length}`);
}

async function main() {
  // COMMUTER: shared start waypoint, runners peel to DIFFERENT manual finishes (officeA/B/C).
  // Real coords (central London-ish) so the map shows something sensible.
  const start = wp("start", 51.5200, -0.1000);
  const dest = wp("dest", 51.5400, -0.0800);
  await seed("commut", session([
    person("Ava", { startPin: atWp("start"), finishPin: atPlace(51.5380, -0.0600, "Office A") }),
    person("Ben", { startPin: atWp("start"), finishPin: atPlace(51.5320, -0.0700, "Office B") }),
    person("Cleo", { startPin: atWp("start"), finishPin: atPlace(51.5450, -0.0900, "Office C") }),
  ], [start, dest], { intendedDistanceKm: 5 }));

  // FINISH-AT-REUNION: home → café(15-min stop) → park. "Quinn" finishes AT the café (coffee
  // with everyone, then peels off); "Remy" runs the whole route. Quinn must show café credit.
  const cafe = wp("cafe", 51.5300, -0.0950, 15);
  await seed("reunio", session([
    person("Quinn", { finishPin: atWp("cafe") }),
    person("Remy"),
  ], [wp("home2", 51.5200, -0.1100), cafe, wp("park", 51.5400, -0.0800)], { intendedDistanceKm: 5 }));

  // DEADLINE REUNION (Landing 3): a long café stop + a fast runner with a tight finish time.
  // Slowest-wins would evict the fast runner before the café; the deadline-snap finishes them AT
  // the café and parks them for the reunion until their deadline.
  const bigCafe = wp("bigcafe", 51.5260, -0.1000, 60);
  await seed("deadli", session([
    person("Sam", { pace: 420 }),
    person("Tess", { pace: 420 }),
    person("Zoe", { pace: 300, latestFinishTime: "08:00" }),
  ], [wp("startd", 51.5200, -0.1100), bigCafe, wp("endd", 51.5330, -0.0850)], { intendedDistanceKm: 6 }));

  // CONNECTOR ASYMMETRY: one runner with a near manual start + far manual finish — the
  // landing's headline case (departure must match the schedule, not be pulled early).
  const w1 = wp("w1", 51.5200, -0.1200);
  const w2 = wp("w2", 51.5300, -0.0900);
  await seed("connas", session([
    person("Dana"),
    person("Eli", { startPin: atPlace(51.5190, -0.1230, "near home"), finishPin: atPlace(51.5380, -0.0650, "far office") }),
  ], [w1, w2], { intendedDistanceKm: 6 }));

  // CORRIDOR (the kwhw9x shape): a 2-waypoint organizer route (Convent → East Richmond) with two
  // manual-start / free-finish runners whose homes sit before/beside the first waypoint. Both must
  // now traverse the Convent and meet for the whole corridor (the endpoint-anchoring fix). Also
  // exercises the place-named schedule ("Set off from 13 Hawthorn Road").
  await seed("convnt", session([
    person("Peter", { startPin: atPlace(-37.7706783, 144.9924143, "13 Hawthorn Road, Northcote") }),
    person("Collin", { startPin: atPlace(-37.8142454, 144.9631732, "Melbourne, Victoria") }),
  ], [
    { ...wp("convent", -37.8025203, 145.0035085), name: "Convent Bakery", address: "Convent Bakery, St Heliers St" },
    { ...wp("richmond", -37.8263517, 144.9966361), name: "East Richmond", address: "East Richmond, Church St" },
  ]));

  // PARTY FIXTURE (m53enq) — the flock the _st_party suite asserts against: 5 manual-start runners,
  // staggered earliests, converging through PrincesPark → CarltonCafe (15-min coffee stop) → Abbotsford.
  // Seeded here (deterministic fake-ORS) so it can be regenerated; _st_party reads the baked output.
  await seed("m53enq", session([
    person("Mara", { startPin: atPlace(-37.77, 144.999, "Mara"), pace: 330, earliestStartTime: "07:00", maxDistanceKm: 24 }),
    person("Cole", { startPin: atPlace(-37.814, 144.963, "Cole"), pace: 300, earliestStartTime: "07:00" }),
    person("Nia", { startPin: atPlace(-37.824, 145.0, "Nia"), pace: 390, earliestStartTime: "07:00", latestFinishTime: "08:15", maxDistanceKm: 11 }),
    person("Tom", { startPin: atPlace(-37.767, 144.96, "Tom"), pace: 360, earliestStartTime: "07:00", maxDistanceKm: 15 }),
    person("Pippa", { startPin: atPlace(-37.806, 145.03, "Pippa"), pace: 420, earliestStartTime: "07:00", maxDistanceKm: 7 }),
  ], [
    wp("PrincesPark", -37.784, 144.961, 0),
    wp("CarltonCafe", -37.805, 144.972, 15),
    wp("Abbotsford", -37.8, 145.005, 0),
  ]));
}
main().catch((e) => { console.error(e); process.exit(1); });
