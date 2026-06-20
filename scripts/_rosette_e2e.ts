// End-to-end: run the REAL engine (calculateRoutes) on the 5e5qae session with LIVE
// ORS, so the AUTO rosette actually fires, and measure each runner's shared fraction.
//   npx tsx scripts/_rosette_e2e.ts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
process.env.FLOCK_LOG_LEVEL ??= "info";
import type { FlockSession } from "../src/lib/types";

async function main() {
  const { calculateRoutes } = await import("../src/lib/routeEngine");
  const session = JSON.parse(readFileSync("/tmp/5e5qae.json", "utf8")) as FlockSession;
  const names: Record<string, string> = {};
  const maxDist: Record<string, number | null | undefined> = {};
  for (const p of session.participants) { names[p.id] = p.name; maxDist[p.id] = p.maxDistance; }

  const res = await calculateRoutes(session);
  const PACE_MIN_PER_KM = 380 / 60;

  console.log("\n=== ROUTES ===");
  for (const r of res.routes) {
    const cap = maxDist[r.participantId];
    console.log(`  ${names[r.participantId].padEnd(7)} ${r.distanceKm.toFixed(2)}km  arrive ${r.arrivalTime}` +
      (cap ? `  (cap ${cap}${r.distanceKm > cap + 0.6 ? " ⚠OVER" : " ok"})` : "  (uncapped)"));
  }

  console.log("\n=== SHARED SEGMENTS ===");
  for (const s of res.sharedSegments) {
    console.log(`  ${s.overlapMinutes.toFixed(1)}min  [${s.participantIds.map((id) => names[id]).join(", ")}]`);
  }

  console.log("\n=== SHARED FRACTION (shared km / total km) ===");
  for (const r of res.routes) {
    const mins = res.sharedSegments
      .filter((s) => s.participantIds.includes(r.participantId))
      .reduce((a, s) => a + s.overlapMinutes, 0);
    const sharedKm = mins / PACE_MIN_PER_KM;
    const frac = (100 * sharedKm) / r.distanceKm;
    console.log(`  ${names[r.participantId].padEnd(7)} shared ~${sharedKm.toFixed(1)}km of ${r.distanceKm.toFixed(1)}km = ${frac.toFixed(0)}%`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
