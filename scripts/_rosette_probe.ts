// ---------------------------------------------------------------------------
// ROSETTE PROBE — the make-or-break experiment for PEEL-AT-HOME (nested laps).
//
// The principle: build the AUTO backbone so its arc-length RETURNS TO THE
// RENDEZVOUS at each runner's budget, so "budget exhausted" == "arrived home".
// The one thing arithmetic can't answer: can REAL ORS round-trips actually form
// laps that pass back through the rendezvous mid-route, and SURVIVE the REAL
// despurLoop (which deletes zero-area out-and-back folds — and the seam where two
// laps meet at the root is exactly such a fold if they share a spoke)?
//
// This probe fires live ORS at the real 5e5qae rendezvous and reuses the REAL
// despurLoop + getRoute (so it tests production de-spur, not a re-implementation).
// It checks three constructions and, for each, whether Jimmy can peel AT HOME and
// what his REAL routed egress would be.
//
//   npx tsx scripts/_rosette_probe.ts
//
// Loads ORS_API_KEY from .env.local. ~10 ORS calls; paced for the free tier.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { despurLoop, distanceMeters, fromORS, toORS } from "../src/lib/geo";
import { getRoute } from "../src/lib/ors";
import type { LatLng } from "../src/lib/types";

// --- load .env.local (tsx does not auto-load it the way Next does) ----------
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
process.env.FLOCK_LOG_LEVEL ??= "warn";

const ORS_BASE = "https://api.openrouteservice.org/v2/directions/foot-hiking/geojson";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const km = (a: LatLng, b: LatLng) => distanceMeters(a, b) / 1000;
const f2 = (n: number) => n.toFixed(2);

// Raw ORS round-trip with a tunable `points` (production getRoundTrip hardcodes 4).
// Returns the RAW (pre-despur) polyline so we can measure what de-spur does to it.
async function rawRoundTrip(start: LatLng, lengthKm: number, seed: number, points: number): Promise<LatLng[]> {
  const res = await fetch(ORS_BASE, {
    method: "POST",
    headers: {
      Authorization: process.env.ORS_API_KEY ?? "",
      "Content-Type": "application/json",
      Accept: "application/geo+json",
    },
    body: JSON.stringify({
      coordinates: [toORS(start)],
      preference: "recommended",
      units: "km",
      instructions: false,
      elevation: false,
      options: { avoid_features: ["steps", "ferries"], round_trip: { length: Math.round(lengthKm * 1000), points, seed } },
    }),
  });
  if (!res.ok) throw new Error(`ORS ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { features: { geometry: { coordinates: [number, number][] } }[] };
  return j.features[0].geometry.coordinates.map(fromORS);
}

function cumKm(c: LatLng[]): number[] {
  const a = [0];
  for (let i = 1; i < c.length; i++) a.push(a[i - 1] + distanceMeters(c[i - 1], c[i]) / 1000);
  return a;
}
const lenKm = (c: LatLng[]) => cumKm(c).at(-1) ?? 0;

// Interior passes near `center`: local minima of dist-to-center below `threshM`,
// excluding the loop's own start/end. Each is a candidate "peel AT home" point.
function centerPasses(c: LatLng[], center: LatLng, threshM: number) {
  const cc = cumKm(c);
  const out: { arcKm: number; distM: number; pt: LatLng }[] = [];
  let cur: { arcKm: number; distM: number; pt: LatLng } | null = null;
  for (let i = 3; i < c.length - 3; i++) {
    const d = distanceMeters(c[i], center);
    if (d < threshM) {
      if (!cur || d < cur.distM) cur = { arcKm: cc[i], distM: d, pt: c[i] };
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// point at arc-km along a polyline (for placing Jimmy's exit on the control lobe)
function pointAtKm(c: LatLng[], target: number): LatLng {
  const cc = cumKm(c);
  let i = 1;
  while (i < cc.length && cc[i] < target) i++;
  if (i >= c.length) return c.at(-1)!;
  const f = cc[i] > cc[i - 1] ? (target - cc[i - 1]) / (cc[i] - cc[i - 1]) : 0;
  return { lat: c[i - 1].lat + (c[i].lat - c[i - 1].lat) * f, lng: c[i - 1].lng + (c[i].lng - c[i - 1].lng) * f };
}

// ---------------------------------------------------------------------------
const center: LatLng = { lat: -37.79085, lng: 144.97741 }; // 5e5qae rendezvous (centroid)
const jimmy: LatLng = { lat: -37.78839, lng: 144.97084 }; // Jimmy's home
const JIMMY_BUDGET = 17.3; // his maxDistance (km)
const JIMMY_APPROACH = km(jimmy, center); // crow; ~his rib to the root
const HOME_THRESH_M = 200; // "passes back through home" tolerance
const PACE = 380; // flock pace s/km

async function evalBackbone(name: string, raw: LatLng[]) {
  const rawLen = lenKm(raw);
  const { coords, distanceKm } = despurLoop(raw); // the REAL production de-spur
  const trimmed = rawLen - distanceKm;
  const passes = centerPasses(coords, center, HOME_THRESH_M);
  console.log(`\n■ ${name}`);
  console.log(`   raw ${f2(rawLen)}km → de-spurred ${f2(distanceKm)}km  (trimmed ${f2(trimmed)}km, ${raw.length}→${coords.length} pts)`);
  if (passes.length === 0) {
    console.log(`   interior home-passes (≤${HOME_THRESH_M}m from rendezvous): NONE — single lobe, no mid-route return`);
  } else {
    console.log(`   interior home-passes: ${passes.length} →` +
      passes.map((p) => ` [arc ${f2(p.arcKm)}km, ${Math.round(p.distM)}m]`).join(""));
  }
  // Jimmy's best affordable peel: the deepest interior home-pass he can still reach,
  // i.e. arc + tiny egress ≤ budget. If a home-pass exists, egress ≈ approach.
  const reachable = passes.filter((p) => p.arcKm + JIMMY_APPROACH <= JIMMY_BUDGET + 0.3);
  const best = reachable.at(-1);
  if (best) {
    const eg = await getRoute([best.pt, jimmy]); // REAL routed egress home from the peel point
    const shared = best.arcKm;
    const total = JIMMY_APPROACH + shared + eg.distanceKm;
    const frac = (100 * shared) / total;
    console.log(`   ★ Jimmy peels AT a home-pass: shared ${f2(shared)}km, REAL egress ${f2(eg.distanceKm)}km, ` +
      `total ${f2(total)}km ≤ ${JIMMY_BUDGET}? ${total <= JIMMY_BUDGET + 0.3 ? "yes" : "NO"}, shared-fraction ${frac.toFixed(0)}%, ` +
      `all-together ~${Math.round((shared * PACE) / 60)}min`);
  } else {
    // No home-pass within reach: simulate today's behaviour — exit at his max affordable
    // arc on this shape and route the real cross-country egress home.
    const arc = Math.min(JIMMY_BUDGET - JIMMY_APPROACH - 1, distanceKm * 0.45);
    const exitPt = pointAtKm(coords, arc);
    const eg = await getRoute([exitPt, jimmy]);
    const total = JIMMY_APPROACH + arc + eg.distanceKm;
    console.log(`   ✗ no reachable home-pass — Jimmy exits at arc ${f2(arc)}km, REAL egress ${f2(eg.distanceKm)}km SOLO, ` +
      `shared-fraction ${(100 * arc / total).toFixed(0)}%`);
  }
  return { distanceKm, passes };
}

async function main() {
  console.log(`Rosette probe @ 5e5qae rendezvous ${center.lat},${center.lng}`);
  console.log(`Jimmy home ${jimmy.lat},${jimmy.lng} — approach (crow) ${f2(JIMMY_APPROACH)}km, budget ${JIMMY_BUDGET}km\n`);

  // ---- CONTROL: today's single lobe (points=4), sized to the anchors' reach ~21km ----
  try {
    const lobe = await rawRoundTrip(center, 21, 1, 4);
    await evalBackbone("CONTROL — single lobe, points=4, ~21km (today's AUTO geometry)", lobe);
  } catch (e) { console.log("  CONTROL failed:", String(e).slice(0, 120)); }
  await sleep(1600);

  // ---- TEST B: ONE round-trip, more points → does it naturally petal through center? ----
  for (const pts of [8, 12]) {
    for (const seed of [1, 4]) {
      try {
        const r = await rawRoundTrip(center, 22, seed, pts);
        await evalBackbone(`TEST B — single round-trip, points=${pts}, seed=${seed}, ~22km`, r);
      } catch (e) { console.log(`  B points=${pts} seed=${seed} failed:`, String(e).slice(0, 100)); }
      await sleep(1600);
    }
  }

  // ---- TEST C: TWO laps concatenated at the root (lap1=Jimmy's ~16km, lap2=anchors ~7km) ----
  // distinct seeds so the laps leave the root in different directions (anti-seam-fold).
  for (const [s1, s2] of [[1, 9], [3, 21], [5, 30]]) {
    try {
      const lap1 = await rawRoundTrip(center, 16, s1, 4);
      await sleep(1600);
      const lap2 = await rawRoundTrip(center, 7, s2, 4);
      // concatenate: lap1 [root..root] then lap2 [root..root], dropping the duplicate seam vertex
      const concat = lap1.concat(lap2.slice(1));
      await evalBackbone(`TEST C — concat lap1(16km,seed${s1}) + lap2(7km,seed${s2})`, concat);
    } catch (e) { console.log(`  C seeds ${s1}/${s2} failed:`, String(e).slice(0, 100)); }
    await sleep(1600);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
