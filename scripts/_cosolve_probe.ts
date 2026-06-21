// CO-SOLVE PROTOTYPE — the make-or-break for the joint F/D commute-ledger fix, against LIVE ORS.
// For 5e5qae (single far café, finish==home so F/D are mirror images), scan the meeting point P
// back along centroid(homes)→café and measure, per candidate: each runner's joint detour vs their
// pool = cap − obligated-commute; the shared lead length; and Jimmy's resulting shared fraction +
// solo stubs. Confirms (a) the joint HARD gate holds under REAL routing for BOTH leads at once,
// (b) P sliding onto the cluster yields a real shared lead, (c) Jimmy clears ~0.85.
//   npx tsx scripts/_cosolve_probe.ts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
process.env.FLOCK_LOG_LEVEL ??= "warn";
import { distanceMeters } from "../src/lib/geo";
import { getRoute } from "../src/lib/ors";
import type { LatLng } from "../src/lib/types";

const ROAD_FACTOR = 1.3;
const f2 = (n: number) => n.toFixed(2);
const km = async (a: LatLng, b: LatLng) => (await getRoute([a, b])).distanceKm;
const lerp = (a: LatLng, b: LatLng, t: number): LatLng => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

async function main() {
  const s = JSON.parse(readFileSync("/tmp/5e5qae_now.json", "utf8"));
  const cafe: LatLng = s.waypoints[0].location;
  const runners = s.participants.map((p: { name: string; startLocation: LatLng; maxDistance: number | null; preferredPace: number | null }) => ({
    name: p.name, home: p.startLocation, cap: p.maxDistance ?? Infinity,
  }));
  const centroid: LatLng = {
    lat: runners.reduce((a: number, r) => a + r.home.lat, 0) / runners.length,
    lng: runners.reduce((a: number, r) => a + r.home.lng, 0) / runners.length,
  };
  console.log(`café ${f2(cafe.lat)},${f2(cafe.lng)} | centroid ${f2(centroid.lat)},${f2(centroid.lng)} | ${(distanceMeters(centroid, cafe) / 1000).toFixed(2)}km apart\n`);

  // obligated commute + pool per runner (finish==home → there-and-back = 2× home→café road)
  const obl: Record<string, number> = {};
  const pool: Record<string, number> = {};
  for (const r of runners) {
    const one = await km(r.home, cafe);
    obl[r.name] = one * 2;
    pool[r.name] = r.cap - obl[r.name];
    console.log(`  ${r.name.padEnd(7)} home→café ${f2(one)}km · obligated ${f2(obl[r.name])}km · cap ${r.cap} · POOL ${f2(pool[r.name])}km`);
  }
  console.log("\nScan P back along café→centroid (t=0 café … t=1 cluster); P_D mirrors P_F by symmetry:");
  console.log("  t   leadKm  Jimmy: head detour jointDetour pool  fits?  | shared% (lead×2 of total)");

  let best: { t: number; frac: number } | null = null;
  for (const t of [0.0, 0.3, 0.5, 0.7, 0.85, 1.0, 1.15]) {
    const P = lerp(cafe, centroid, t); // t>1 overshoots past the cluster toward homes' far side
    const lead = await km(P, cafe); // the SHARED leg P→café (run together); P_D→café mirrors it
    // per-runner joint detour = 2×(home→P + lead − home→café)  [both legs, symmetric]
    let fits = true;
    const detail: Record<string, { head: number; jd: number }> = {};
    for (const r of runners) {
      if (!Number.isFinite(r.cap)) continue;
      const head = await km(r.home, P);
      const oneWay = obl[r.name] / 2;
      const detour = head + lead - oneWay;
      const jd = 2 * detour;
      detail[r.name] = { head, jd };
      if (jd > pool[r.name] + 0.3) fits = false;
    }
    const j = detail["Jimmy"];
    // Jimmy if committed at this t: shared ≈ 2×lead (both leads); solo ≈ 2×head; total = solo+shared (+~0 arc)
    const shared = 2 * lead;
    const solo = 2 * (j?.head ?? 0);
    const total = solo + shared;
    const frac = total > 0 ? shared / total : 0;
    console.log(`  ${t.toFixed(2)}  ${f2(lead).padStart(5)}   Jimmy: ${f2(j?.head ?? 0)}  ${f2((j?.head ?? 0) + lead - obl["Jimmy"] / 2)}   ${f2(j?.jd ?? 0).padStart(5)}    ${f2(pool["Jimmy"])}  ${fits ? "YES" : "no "}   | ${(frac * 100).toFixed(0)}%  (shared ${f2(shared)} / ${f2(total)}km, solo ${f2(solo)})`);
    if (fits && (!best || frac > best.frac)) best = { t, frac };
  }
  console.log(best
    ? `\n★ best feasible: t=${best.t}, Jimmy ≈ ${(best.frac * 100).toFixed(0)}% shared  (today: 45%; floor 0.85)`
    : "\n✗ no feasible meeting point — co-solve can't help here");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
