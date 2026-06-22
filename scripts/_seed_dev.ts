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
}
main().catch((e) => { console.error(e); process.exit(1); });
