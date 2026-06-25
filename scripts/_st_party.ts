// Flock Party simulation — OUTCOME test suite.
// Category: party — the loosely-coupled animation seam (no engine involved).
//   npx tsx scripts/_st_party.ts
//
// We feed REAL routing output (a saved .flock-data fixture) into buildPartySim and
// assert the simulation is faithful: positions stay on each runner's geometry, the
// integrated path length matches the route's distance, start/rest/finish states land
// where the schedule says, companion sets agree with the schedule, and the derived
// events (set-offs, meets, farewells, the coffee stop, finishes) match the known run.
// Outcome-first per the project's testing lesson — not just "it didn't throw".

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pointToSegmentMeters } from "../src/lib/geo";
import type { ComputedRoute, FlockSession } from "../src/lib/types";
import { timeToSec } from "../src/lib/units";
import { buildPartySim, flockGroups } from "../src/lib/party/simulate";
import { ok, suite, section, finish } from "./_st_harness";

const FIXTURE = "flock-m53enq"; // 5 runners, 3 convergences, a 15-min coffee stop

function loadSession(slug: string): FlockSession {
  const raw = readFileSync(join(process.cwd(), ".flock-data", `${slug}.json`), "utf8");
  return (JSON.parse(raw) as { session: FlockSession }).session;
}

/** Min distance (m) from a point to a [lng,lat] polyline. */
function distToLine(line: GeoJSON.LineString, p: { lat: number; lng: number }): number {
  const pts = line.coordinates.map(([lng, lat]) => ({ lat, lng }));
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, pointToSegmentMeters(p, pts[i - 1], pts[i]));
  return best;
}

const haversine = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function main() {
  suite("party");
  const s = loadSession(FIXTURE);
  const routes = s.computedRoutes as ComputedRoute[];
  const nameOf = (id: string) => s.participants.find((p) => p.id === id)?.name ?? id;
  const idOf = (name: string) => s.participants.find((p) => p.name === name)!.id;

  section("0. fixture sanity");
  ok(routes?.length === 5, `fixture has 5 computed routes (got ${routes?.length})`);

  const sim = buildPartySim({ participants: s.participants, routes, sharedSegments: s.sharedSegments ?? [] })!;
  ok(sim != null, "buildPartySim produced a simulation");

  section("1. time window matches the schedule");
  ok(sim.tStart === timeToSec("07:00"), `tStart = 07:00 (got ${sim.tStart}s)`);
  ok(sim.tEnd === timeToSec("08:27"), `tEnd = 08:27 (got ${sim.tEnd}s)`);
  ok(sim.finaleAt === sim.tEnd, "finale fires when the last runner finishes");

  section("2. every runner starts at start, finishes at finish, and stays ON their geometry");
  for (const r of routes) {
    const tr = sim.byId[r.participantId];
    const nm = nameOf(r.participantId);
    const atStart = tr.frameAt(tr.startSec);
    const atFinish = tr.frameAt(tr.finishSec);
    const geomStart = { lat: r.geometry.coordinates[0][1], lng: r.geometry.coordinates[0][0] };
    const last = r.geometry.coordinates[r.geometry.coordinates.length - 1];
    const geomFinish = { lat: last[1], lng: last[0] };
    ok(haversine(atStart.pos, geomStart) < 5, `${nm}: at departure sits at route start`);
    ok(haversine(atFinish.pos, geomFinish) < 5, `${nm}: at arrival sits at route end`);
    ok(tr.frameAt(tr.startSec - 60).state === "before", `${nm}: idle before departure`);
    ok(tr.frameAt(tr.finishSec + 60).state === "finished", `${nm}: finished after arrival`);

    // Sample densely through the run; every position must lie on the polyline.
    let maxOff = 0;
    const N = 240;
    for (let k = 0; k <= N; k++) {
      const t = tr.startSec + ((tr.finishSec - tr.startSec) * k) / N;
      maxOff = Math.max(maxOff, distToLine(r.geometry, tr.frameAt(t).pos));
    }
    ok(maxOff < 5, `${nm}: every sampled position is on-route (max ${maxOff.toFixed(2)}m off)`);

    // The integrated travelled distance ≈ the route's own distance (exact mapping check).
    let travelled = 0;
    let prev = tr.frameAt(tr.startSec).pos;
    for (let k = 1; k <= 2000; k++) {
      const t = tr.startSec + ((tr.finishSec - tr.startSec) * k) / 2000;
      const cur = tr.frameAt(t).pos;
      travelled += haversine(prev, cur);
      prev = cur;
    }
    const relErr = Math.abs(travelled / 1000 - r.distanceKm) / r.distanceKm;
    ok(relErr < 0.02, `${nm}: integrated path ≈ route distance (${(travelled / 1000).toFixed(2)} vs ${r.distanceKm} km, ${(relErr * 100).toFixed(1)}%)`);
  }

  section("3. companion sets + rest state agree with the schedule");
  const mara = idOf("Mara"), cole = idOf("Cole"), tom = idOf("Tom"), nia = idOf("Nia"), pippa = idOf("Pippa");
  // 07:40 — Mara, Cole, Nia, Tom converging (Pippa still on her approach).
  const f0740 = sim.byId[mara].frameAt(timeToSec("07:40"));
  ok(f0740.state === "running" && sameSet(f0740.companions, [cole, nia, tom]), "Mara at 07:40 runs with Cole + Nia + Tom");
  // 07:55 — Mara, Cole, Nia, Tom at the café (rest 07:51–08:06).
  for (const id of [mara, cole, nia, tom]) {
    const fr = sim.byId[id].frameAt(timeToSec("07:55"));
    ok(fr.state === "resting" && !fr.moving, `${nameOf(id)} is resting at 07:55`);
  }
  // 08:10 — Pippa has caught up post-café, so the whole flock runs together briefly.
  const f0810 = sim.byId[mara].frameAt(timeToSec("08:10"));
  ok(f0810.state === "running" && sameSet(f0810.companions, [cole, nia, pippa, tom]), "Mara at 08:10 runs with the whole flock");

  section("4. derived events match the known run");
  const kinds = (k: string) => sim.events.filter((e) => e.kind === k);
  ok(kinds("start").length === 5, `5 set-offs (got ${kinds("start").length})`);
  ok(kinds("finish").length === 5, `5 finishes (got ${kinds("finish").length})`);
  ok(kinds("meet").length === 3, `3 meet-ups from convergences (got ${kinds("meet").length})`);
  ok(kinds("stop-arrive").length === 1, `1 coffee stop arrival (got ${kinds("stop-arrive").length})`);
  ok(kinds("stop-depart").length === 1, `1 coffee stop departure`);

  // The stop is shared by Mara, Cole, Tom at one place → one grouped event + one flag.
  const stopIn = kinds("stop-arrive")[0];
  ok(sameSet(stopIn.subjectIds, [mara, cole, nia, tom]), "coffee stop groups Mara + Cole + Nia + Tom");
  ok(stopIn.t === timeToSec("07:51"), "coffee stop arrival at 07:51");

  // Farewells: Nia finishes first and parts the flock at 08:14; Pippa parts at 08:25. Deduped per pair.
  const byes = kinds("farewell").map((e) => `${[...e.subjectIds, ...e.withIds].map(nameOf).sort().join("+")}@${Math.round(e.t / 60 - timeToSec("00:00") / 60)}`);
  const tomByes = kinds("farewell").filter((e) => e.subjectIds.includes(tom) || e.withIds.includes(tom));
  ok(tomByes.length >= 1, `Tom says farewell when his companions peel off (${byes.join(", ")})`);
  const niaBye = kinds("farewell").some(
    (e) => (e.subjectIds.includes(nia) || e.withIds.includes(nia)) && e.t === timeToSec("08:14"),
  );
  ok(niaBye, "Nia parts the flock when she finishes first, at 08:14");

  section("5. flags + sorted, in-window events");
  ok(sim.flags.filter((f) => f.kind === "finish").length === 5, "a finish flag per runner");
  ok(sim.flags.filter((f) => f.kind === "stop").length === 1, "one coffee-stop flag");
  const stopFlag = sim.flags.find((f) => f.kind === "stop")!;
  ok(stopFlag.removeAt === timeToSec("08:06"), "coffee flag folds up when the café empties (08:06)");
  ok(sim.flags.filter((f) => f.kind === "finish").every((f) => f.removeAt === null), "finish flags stay planted");
  ok(sim.events.every((e, i) => i === 0 || sim.events[i - 1].t <= e.t), "events are time-sorted");
  ok(sim.events.every((e) => e.t >= sim.tStart && e.t <= sim.tEnd), "every event lands inside the run window");

  section("6. flockGroups — merge co-located runners (mutual companions only)");
  const grpKey = (gs: string[][]) => gs.map((g) => g.join(",")).sort().join(" | ");
  ok(grpKey(flockGroups({ a: [], b: [], c: [] })) === "a | b | c", "no companions → all singletons");
  ok(grpKey(flockGroups({ a: ["b", "c"], b: ["a", "c"], c: ["a", "b"] })) === "a,b,c", "mutual triangle → one group of 3");
  ok(grpKey(flockGroups({ a: ["b"], b: ["a"], c: ["d"], d: ["c"] })) === "a,b | c,d", "two mutual pairs → two groups");
  ok(grpKey(flockGroups({ a: ["b"], b: [], c: [] })) === "a | b | c", "asymmetric edge (a→b, b↛a) → no merge");
  ok(grpKey(flockGroups({ a: ["ghost"], b: [] })) === "a | b", "companion not present → ignored");
  // The fixture at 07:40 should fold Mara+Cole+Nia+Tom into one group; Pippa is still on her approach.
  const fr = (id: string) => sim.byId[id].frameAt(timeToSec("07:40"));
  const companions: Record<string, string[]> = {};
  for (const r of routes) if (!sim.byId[r.participantId].parked) companions[r.participantId] = fr(r.participantId).companions;
  const groups0740 = flockGroups(companions);
  const quartet = groups0740.find((g) => g.length === 4);
  ok(quartet != null && sameSet(quartet, [mara, cole, nia, tom]), "at 07:40 the fixture merges Mara+Cole+Nia+Tom into one group");
  ok(groups0740.filter((g) => g.length === 1).length === 1, "at 07:40 only Pippa stays solo (1 singleton)");

  finish();
}

main();
