// ---------------------------------------------------------------------------
// Combinatorial / property-based routing suite for calculateRoutes (Step-3 of the
// routing test campaign). Engine contract only (CalcResult), 100% fake-ORS.
//
// Oracle = invariant battery (A–N) + metamorphic relations, NOT golden output.
// Three tallies: HARD (must be green on the shipped engine), SOFT (heuristic/known
// soft holes), XFAIL (documented engine holes — recorded, never reddens HARD).
//
// Run: npx tsx scripts/_st_combo.ts
// Spec: ~/.claude/plans/flock-routing-test-megaplan.md
// ---------------------------------------------------------------------------

import {
  calculateRoutes,
  person,
  wp,
  session,
  atWp,
  atPlace,
  auto,
  suite,
  section,
  type FlockSession,
  type Participant,
  type FlockWaypoint,
  type LocationPin,
} from "./_st_harness";

// --- tallies (local; the shared harness ok/finish are not used here) ---------
let hardPass = 0;
const hardFails: string[] = [];
let softPass = 0;
const softFails: string[] = [];
const xfails: { label: string; asExpected: boolean }[] = [];
let curSig = "";

const okH = (cond: boolean, msg: string) => {
  if (cond) hardPass++;
  else hardFails.push(`${curSig} — ${msg}`);
};
const okS = (cond: boolean, msg: string) => {
  if (cond) softPass++;
  else softFails.push(`${curSig} — ${msg}`);
};
const okX = (label: string, violatedAsExpected: boolean) =>
  xfails.push({ label: `${curSig} — ${label}`, asExpected: violatedAsExpected });

// --- geometry & time helpers -------------------------------------------------
const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
function hav(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return (2 * R * Math.asin(Math.sqrt(s))) / 1000; // km
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHHMM = (s: unknown): boolean => typeof s === "string" && HHMM.test(s);
const toSec = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return h * 3600 + m * 60;
};
// Unwrap a sequence of HH:MM into monotone seconds (add a day on any decrease) so a
// midnight-crossing schedule isn't mistaken for going backwards.
function unwrap(times: string[]): number[] {
  const out: number[] = [];
  let base = 0, prev = -1;
  for (const t of times) {
    let s = toSec(t);
    if (prev >= 0 && s < prev) base += 86400;
    out.push(s + base);
    prev = s;
  }
  return out;
}
const finite = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n);
const round2 = (n: number) => Number(n.toFixed(2));

// --- fixed geography ---------------------------------------------------------
const BASE = { lat: -37.81, lng: 144.96 };
// waypoints march east; each ~1.3km apart at this latitude (0.015 deg lng).
const wpAt = (k: number, stop = 0): FlockWaypoint => wp(`w${k}`, BASE.lat, BASE.lng + 0.015 * k, stop);
const NEAR: LocationPin = atPlace(BASE.lat, BASE.lng + 0.012, "near"); // ~1.05 km off km0
const FAR: LocationPin = atPlace(BASE.lat, BASE.lng + 0.25, "far"); // ~22 km away

// --- result helpers ----------------------------------------------------------
type Res = Awaited<ReturnType<typeof calculateRoutes>>;
type Route = Res["routes"][number];
const byId = (r: Res) => new Map(r.routes.map((x) => [x.participantId, x]));
const objOf = (r: Res) => r.summary.pairwiseSummary.reduce((s, p) => s + p.togetherMinutes, 0);
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
// approach/egress connector km re-derived from the 4-point waypoints array
// [startPt, enterPt, exitPt, finishPt] (project.ts:96). Auto/waypoint pins → ~0.
const approachOf = (rt: Route) => hav(rt.waypoints[0], rt.waypoints[1]);
const egressOf = (rt: Route) => hav(rt.waypoints[2], rt.waypoints[3]);

// canonical form for metamorphic deep-compares: everything order-insensitive.
function canon(r: Res) {
  return {
    skipped: r.skipped,
    total: round2(r.summary.totalTogetherMinutes),
    routes: [...r.routes]
      .map((rt) => ({
        id: rt.participantId,
        distanceKm: round2(rt.distanceKm),
        dur: rt.estimatedDurationMinutes,
        dep: rt.departureTime,
        arr: rt.arrivalTime,
        segs: rt.schedule.map((s) => ({
          type: s.type,
          start: s.startTime,
          end: s.endTime,
          pace: s.paceSecPerKm,
          dist: round2(s.distanceKm),
          comp: [...s.companionIds].sort().join(","),
        })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    pairs: r.summary.pairwiseSummary
      .map((p) => `${pairKey(p.participantA, p.participantB)}:${round2(p.togetherMinutes)}:${p.togetherStretchCount}`)
      .sort(),
    warnings: r.warnings.map((w) => w.participantId).sort(),
    shared: r.sharedSegments
      .map((s) => `${[...s.participantIds].sort().join(",")}:${round2(s.overlapMinutes)}:${s.startTime}:${s.isConvergence ?? "?"}`)
      .sort(),
  };
}

// --- the universal invariant battery ----------------------------------------
function assertInvariants(s: FlockSession, r: Res) {
  const pById = new Map(s.participants.map((p) => [p.id, p]));
  const paceOf = (id: string) => pById.get(id)?.pace ?? 360;
  const hasManual = s.participants.some((p) => p.startPin.kind === "manual" || p.finishPin.kind === "manual");

  // K. Skip contract
  const expectSkip = s.participants.length === 0 || (s.waypoints.length === 0 && !hasManual);
  okH(r.skipped === expectSkip, `K1 skipped=${r.skipped} expected=${expectSkip}`);
  if (r.skipped) {
    okH(
      r.routes.length === 0 && r.sharedSegments.length === 0 && r.flockRoute === null &&
        r.waypointEtas === null && r.summary.totalTogetherMinutes === 0,
      `K2 skipped result not empty`,
    );
    return;
  }

  const n = r.routes.length;
  okH(n === s.participants.length, `route count ${n} != participants ${s.participants.length}`);

  // --- per-runner ---
  for (const rt of r.routes) {
    const p = pById.get(rt.participantId)!;
    const sig = rt.participantId;
    // A PARKED (infeasible) runner is named by a "couldn't place you" warning. Hard constraints
    // (earliest/latest) are honoured for FEASIBLE runners; a parked runner is exempt because its
    // constraints were contradictory — it is flagged, not silently violated.
    const parked = r.warnings.some((w) => w.participantId === rt.participantId && /couldn't place/.test(w.message));
    // A. time validity + structure
    okH(isHHMM(rt.departureTime) && isHHMM(rt.arrivalTime), `A1 ${sig} clock invalid ${rt.departureTime}/${rt.arrivalTime}`);
    for (const seg of rt.schedule) okH(isHHMM(seg.startTime) && isHHMM(seg.endTime), `A1 ${sig} seg clock ${seg.startTime}/${seg.endTime}`);
    const segTimes = rt.schedule.flatMap((s) => [s.startTime, s.endTime]);
    const allTimes = [rt.departureTime, ...segTimes, rt.arrivalTime].filter(isHHMM);
    const uw = unwrap(allTimes);
    let mono = true, chained = true;
    const su = unwrap(segTimes);
    for (let i = 0; i + 1 < su.length; i += 2) {
      if (su[i + 1] < su[i] - 1) mono = false;
      if (i + 2 < su.length && Math.abs(su[i + 2] - su[i + 1]) > 60) chained = false;
    }
    okH(mono, `A2 ${sig} segment end<start`);
    okH(chained, `A2 ${sig} segments not chained`);
    okH(uw[uw.length - 1] >= uw[0] - 1, `A3 ${sig} depart>arrive`);
    // span on UNWRAPPED seconds (a long route may cross midnight — the secToTime no-day-marker
    // limitation, Cause E1, deferred; the duration field itself is correct).
    const a4span = unwrap([rt.departureTime, rt.arrivalTime]);
    okH(rt.estimatedDurationMinutes >= 0 && Math.abs(rt.estimatedDurationMinutes - Math.round((a4span[1] - a4span[0]) / 60)) <= 1,
      `A4 ${sig} duration ${rt.estimatedDurationMinutes} vs span`);
    okH(rt.schedule.length > 0 && rt.departureTime === rt.schedule[0].startTime, `A5 ${sig} departure!=schedule[0].start`);
    okH(rt.schedule.length > 0 && rt.arrivalTime === rt.schedule[rt.schedule.length - 1].endTime, `A6 ${sig} arrival!=schedule[last].end`);
    // A7 unwrapped seconds in range (single day) — flag wrap as XFAIL-ish via soft
    okS(toSec(rt.departureTime) < 86400 && toSec(rt.arrivalTime) < 86400, `A7 ${sig} time out of day range`);

    // B. distance & geometry
    okH(finite(rt.distanceKm) && rt.distanceKm >= 0, `B1 ${sig} distanceKm ${rt.distanceKm}`);
    for (const seg of rt.schedule) {
      okH(finite(seg.distanceKm) && seg.distanceKm >= 0, `B1 ${sig} seg dist ${seg.distanceKm}`);
      okH(seg.type === "rest" ? seg.distanceKm === 0 : true, `B2 ${sig} rest seg has distance ${seg.distanceKm}`);
    }
    const approachKm = approachOf(rt), egressKm = egressOf(rt);
    if (p.maxDistanceKm != null) {
      const arc = rt.distanceKm - approachKm - egressKm;
      const arcCap = Math.max(0, p.maxDistanceKm - approachKm - egressKm);
      okH(arc <= arcCap + 0.06, `B3 ${sig} arc ${round2(arc)} > arcCap ${round2(arcCap)} (cap ${p.maxDistanceKm})`);
    }
    const coords = rt.geometry.coordinates as [number, number][];
    okH(coords.length >= 2, `B4 ${sig} geometry < 2 coords`);
    let coordsOk = true;
    for (const [lng, lat] of coords) if (!finite(lat) || !finite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) coordsOk = false;
    okH(coordsOk, `B4 ${sig} geometry coord out of range / NaN`);

    // C. pace / slowest-wins
    for (const seg of rt.schedule) {
      if (seg.type === "rest") {
        okH(seg.paceSecPerKm === null, `C2 ${sig} rest seg pace not null`);
        continue;
      }
      okH(finite(seg.paceSecPerKm) && (seg.paceSecPerKm as number) > 0, `C2 ${sig} run seg pace ${seg.paceSecPerKm}`);
      if (seg.companionIds.length >= 1) {
        const members = [rt.participantId, ...seg.companionIds];
        const expected = Math.max(...members.map(paceOf));
        okH(Math.abs((seg.paceSecPerKm as number) - expected) <= 1, `C1 ${sig} shared pace ${seg.paceSecPerKm} != max ${expected}`);
      } else {
        // C3 solo leg at own pace (or slower companions absent → own). Allow ±1.
        okS(Math.abs((seg.paceSecPerKm as number) - paceOf(rt.participantId)) <= 1, `C3 ${sig} solo pace ${seg.paceSecPerKm} != own ${paceOf(rt.participantId)}`);
      }
    }

    // G. earliest / latest
    if (p.earliestStartTime != null && !parked) okH(toSec(rt.departureTime) >= toSec(p.earliestStartTime) - 90, `G1 ${sig} departs ${rt.departureTime} before earliest ${p.earliestStartTime}`);
    if (p.latestFinishTime != null && !parked) okH(toSec(rt.arrivalTime) <= toSec(p.latestFinishTime) + 60, `G2 ${sig} arrives ${rt.arrivalTime} after latest ${p.latestFinishTime}`);
    // G3: an earliest-unreachable PARK is a FIXED-anchor outcome only — on AUTO the t0-floor must DELAY
    // the flock, not park a runner who could otherwise run. (G1's !parked gate would hide a floor that
    // under-shoots and wrongly parks a feasible auto runner — so assert no such park on auto here.)
    if (p.earliestStartTime != null && (s.startAnchor == null || s.startAnchor.kind === "auto")) {
      const ew = r.warnings.find((x) => x.participantId === rt.participantId);
      okH(!(ew && /sets off before your earliest start/.test(ew.message)), `G3 ${sig} earliest-unreachable PARK on AUTO (floor under-shot)`);
    }

    // J. warnings (n==1 handled below)
  }

  // D. together-time
  const maxPairs = (n * (n - 1)) / 2;
  okH(r.summary.pairwiseSummary.length <= maxPairs, `D1 pairs ${r.summary.pairwiseSummary.length} > ${maxPairs}`);
  const seenPairs = new Set<string>();
  let pairShapeOk = true;
  for (const pr of r.summary.pairwiseSummary) {
    const k = pairKey(pr.participantA, pr.participantB);
    if (seenPairs.has(k) || pr.participantA === pr.participantB) pairShapeOk = false;
    if (!pById.has(pr.participantA) || !pById.has(pr.participantB)) pairShapeOk = false;
    seenPairs.add(k);
    okH(finite(pr.togetherMinutes) && pr.togetherMinutes >= 0, `D2 ${k} minutes ${pr.togetherMinutes}`);
  }
  okH(pairShapeOk, `D2 pair shape (dup/self/unknown id)`);
  const obj = objOf(r);
  okH(finite(r.summary.totalTogetherMinutes) && r.summary.totalTogetherMinutes >= 0, `D3 total ${r.summary.totalTogetherMinutes}`);
  okH(r.summary.totalTogetherMinutes <= obj + 0.05, `D3 total ${r.summary.totalTogetherMinutes} > pairwise ${round2(obj)}`);
  if (r.summary.pairwiseSummary.length > 0) okH(obj >= Math.max(...r.summary.pairwiseSummary.map((p) => p.togetherMinutes)) - 0.05, `D4 obj < max pair`);
  if (n === 1) {
    okH(r.summary.pairwiseSummary.length === 0 && r.summary.totalTogetherMinutes === 0, `D1 n=1 has pairs`);
    // J1 (relaxed): a solo runner is never told about a "flock"/lonely-overlap that doesn't
    // exist; a self-contradiction ("couldn't place you") warning IS allowed.
    okH(!r.warnings.some((w) => /barely overlap|with the flock for/i.test(w.message)), `J1 n=1 flock/lonely warning: ${r.warnings.map((w) => w.message).join(" | ")}`);
  }
  // D5 companions == block members (set), reconstructed from sharedSegments
  for (const seg of r.sharedSegments) {
    okH(finite(seg.overlapMinutes) && seg.overlapMinutes >= 0, `D-seg overlap ${seg.overlapMinutes}`);
    okH(seg.participantIds.length >= 2, `D-seg members ${seg.participantIds.length}`);
  }
  // D7 objOf == sum over sharedSegments of dur * C(k,2)
  const objFromShared = r.sharedSegments.reduce((s, seg) => {
    const k = seg.participantIds.length;
    return s + seg.overlapMinutes * (k * (k - 1)) / 2;
  }, 0);
  okH(Math.abs(obj - objFromShared) <= 0.1, `D7 objOf ${round2(obj)} != fromShared ${round2(objFromShared)}`);

  // H2. no NaN/Infinity anywhere
  okH(!hasBadNumber(r), `H2 NaN/Infinity in result`);

  // I. waypoint ETAs
  if (r.waypointEtas) {
    for (const [, eta] of Object.entries(r.waypointEtas)) okH(isHHMM(eta), `I1 eta ${eta} invalid`);
  }
}

function hasBadNumber(v: unknown, seen = new Set()): boolean {
  if (typeof v === "number") return !Number.isFinite(v);
  if (v && typeof v === "object") {
    if (seen.has(v)) return false;
    seen.add(v);
    for (const x of Object.values(v as Record<string, unknown>)) if (hasBadNumber(x, seen)) return true;
  }
  return false;
}

// --- per-case runner ---------------------------------------------------------
async function check(sig: string, s: FlockSession): Promise<Res | null> {
  curSig = sig;
  let r: Res;
  try {
    r = await calculateRoutes(s);
  } catch (e) {
    okH(false, `ENGINE THREW: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  try {
    assertInvariants(s, r);
  } catch (e) {
    okH(false, `ORACLE THREW: ${e instanceof Error ? e.message : String(e)}`);
  }
  return r;
}

// --- deterministic covering-array generator (greedy IPOG, RNG-free) ----------
function coverN<T>(dims: T[][], strength: number): number[][] {
  const k = dims.length;
  const idxDims = dims.map((d) => d.map((_, i) => i));
  // all t-way column combinations
  const combos: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === strength) { combos.push([...acc]); return; }
    for (let c = start; c < k; c++) pick(c + 1, [...acc, c]);
  };
  pick(0, []);
  const tupleKey = (cols: number[], row: number[]) => cols.map((c) => `${c}=${row[c]}`).join(",");
  const need = new Set<string>();
  for (const cols of combos) {
    const enumerate = (ci: number, acc: number[]) => {
      if (ci === cols.length) { need.add(tupleKey(cols, accToRow(cols, acc))); return; }
      for (const v of idxDims[cols[ci]]) enumerate(ci + 1, [...acc, v]);
    };
    enumerate(0, []);
  }
  function accToRow(cols: number[], acc: number[]): number[] {
    const row = new Array(k).fill(0);
    cols.forEach((c, i) => (row[c] = acc[i]));
    return row;
  }
  const covered = (row: number[]) => combos.map((cols) => tupleKey(cols, row));
  const rows: number[][] = [];
  const remaining = new Set(need);
  let guard = 0;
  while (remaining.size > 0 && guard++ < 5000) {
    // build a row greedily column by column, choosing the value covering the most remaining tuples
    const row = new Array(k).fill(-1);
    for (let c = 0; c < k; c++) {
      let bestV = 0, bestGain = -1;
      for (const v of idxDims[c]) {
        row[c] = v;
        let gain = 0;
        for (const cols of combos) {
          if (!cols.includes(c)) continue;
          if (cols.some((cc) => row[cc] === -1)) continue;
          if (remaining.has(tupleKey(cols, row))) gain++;
        }
        if (gain > bestGain) { bestGain = gain; bestV = v; }
      }
      row[c] = bestV;
    }
    for (const key of covered(row)) remaining.delete(key);
    rows.push(row);
  }
  return rows.map((row) => row.map((vi, c) => vi)); // index rows
}

// =====================================================================
// GENERATORS
// =====================================================================

// --- L1 structural: W × N × D × A (+ I folded) ---
async function genStructural() {
  section("L1 structural W×N×D×A");
  const Ws = [0, 1, 2, 3, 4];
  const Ns = [1, 2, 3, 6];
  const Ds = ["none", "cafe", "multi"] as const;
  const As = ["auto", "departure", "waypoint"] as const;
  for (const W of Ws)
    for (const N of Ns)
      for (const D of Ds)
        for (const A of As) {
          if (A === "waypoint" && W === 0) continue; // invalid anchor
          if (D !== "none" && W === 0) continue; // no waypoint to stop at
          const wps: FlockWaypoint[] = [];
          for (let k = 1; k <= W; k++) {
            const stop = (D === "cafe" && k === Math.ceil(W / 2)) || (D === "multi" && (k === 1 || k === W)) ? 15 : 0;
            wps.push(wpAt(k, stop));
          }
          const people: Participant[] = [];
          for (let i = 0; i < N; i++) {
            // W=0 forces a manual pin on runner-0 so geography exists.
            const sp = W === 0 && i === 0 ? NEAR : auto;
            people.push(person(`p${i}`, { startPin: sp, finishPin: auto }));
          }
          const anchor =
            A === "auto" ? { kind: "auto" as const } :
            A === "departure" ? { kind: "departure" as const, time: "06:30" } :
            { kind: "waypoint" as const, waypointId: "w1", time: "08:00" };
          const I = W >= 2 ? 18 : null;
          const s = session(people, wps, { startAnchor: anchor, intendedDistanceKm: I });
          await check(`L1/W${W}N${N}D${D}/A${A}`, s);
        }
}

// --- L2 per-runner pairwise: sp,fp,pc,cap,es,lf in N=3/2/1 hosts ---
const SP = [auto, atWp("w1"), NEAR, FAR, atWp("missing")] as const;
const FP = [auto, atWp("w2"), NEAR, FAR, atWp("w1")] as const;
const PC = [null, 240, 360, 600, 900];
const CAP = [null, 0, 0.3, 5, 1000];
const ES = [null, "06:00", "08:00", "09:00"];
const LF = [null, "07:20", "09:00", "11:00"];
function profile(i: number, [sp, fp, pc, cap, es, lf]: number[]): Participant {
  return person(`p${i}`, {
    startPin: SP[sp] as LocationPin,
    finishPin: FP[fp] as LocationPin,
    pace: PC[pc],
    maxDistanceKm: CAP[cap],
    earliestStartTime: ES[es],
    latestFinishTime: LF[lf],
  });
}
async function genPairwise() {
  section("L2 per-runner pairwise (2-wise)");
  const dims = [SP, FP, PC, CAP, ES, LF].map((d) => d.map((_, i) => i));
  const rows = coverN(dims, 2);
  const wps3 = [wpAt(1), wpAt(2, 15), wpAt(3)];
  for (const hostN of [3, 2, 1]) {
    for (let ri = 0; ri < rows.length; ri += hostN) {
      const people: Participant[] = [];
      for (let j = 0; j < hostN; j++) people.push(profile(j, rows[(ri + j) % rows.length]));
      const s = session(people, wps3, { startAnchor: { kind: "auto" }, intendedDistanceKm: 18 });
      await check(`L2/N${hostN}/r${ri}`, s);
    }
  }
}

// --- L3 three-wise triples ---
async function genTriple() {
  section("L3 3-wise triples");
  const wps3 = [wpAt(1), wpAt(2, 15), wpAt(3)];
  // sp × fp × cap
  for (const dims of [[SP, FP, CAP], [CAP, LF, PC]]) {
    const rows = coverN(dims.map((d) => d.map((_, i) => i)), 3);
    for (let ri = 0; ri < rows.length; ri += 3) {
      const people: Participant[] = [];
      for (let j = 0; j < 3; j++) {
        const row = rows[(ri + j) % rows.length];
        // map the 3 chosen dims into a full 6-dim profile (rest = baseline 0/auto)
        const full = [0, 0, 0, 0, 0, 0];
        if (dims[0] === SP) { full[0] = row[0]; full[1] = row[1]; full[3] = row[2]; }
        else { full[3] = row[0]; full[5] = row[1]; full[2] = row[2]; }
        people.push(profile(j, full));
      }
      const s = session(people, wps3, { startAnchor: { kind: "auto" }, intendedDistanceKm: 18 });
      await check(`L3/${dims[0] === SP ? "spfpcap" : "caplfpc"}/r${ri}`, s);
    }
  }
}

// --- L4 boundary value ---
async function genBoundary() {
  section("L4 boundary value");
  const wps2 = [wpAt(1), wpAt(2)];
  const caps = [0, 0.3, -5, 1000];
  for (const cap of caps) await check(`L4/cap=${cap}`, session([person("a", { maxDistanceKm: cap }), person("b")], wps2, { intendedDistanceKm: 12 }));
  for (const lf of ["07:01", "07:20"]) await check(`L4/lf=${lf}`, session([person("a", { latestFinishTime: lf }), person("b")], wps2, { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 12 }));
  for (const es of ["09:00"]) await check(`L4/es=${es}`, session([person("a", { earliestStartTime: es }), person("b")], wps2, { intendedDistanceKm: 12 }));
  for (const I of [0, 0.5, -5, 500]) await check(`L4/I=${I}`, session([person("a"), person("b")], [wpAt(1)], { intendedDistanceKm: I }));
  for (const stop of [0, 600]) await check(`L4/stop=${stop}`, session([person("a"), person("b")], [wpAt(1, stop), wpAt(2)], { intendedDistanceKm: 12 }));
  for (const pc of [240, 900]) await check(`L4/pc=${pc}`, session([person("a", { pace: pc }), person("b", { pace: 360 })], wps2, { intendedDistanceKm: 12 }));
}

// --- L4c dwell arc-position: opening dwell, finish-at-café, dwell-split ---
async function genDwellArc() {
  section("L4c dwell arc-position");
  // E-open: stop on w1 (≈km0)
  await check("L4c/E-open", session([person("a"), person("b")], [wpAt(1, 15), wpAt(2), wpAt(3)], { intendedDistanceKm: 18 }));
  // E-finish: finish pinned at last café
  await check("L4c/E-finish", session([person("a", { finishPin: atWp("w3") }), person("b")], [wpAt(1), wpAt(2), wpAt(3, 15)], { intendedDistanceKm: 18 }));
  // Dwell-split: café@w2, one finisher with deadline landing mid-dwell
  await check("L4c/dwell-split", session(
    [person("a"), person("b"), person("c", { finishPin: atWp("w2"), latestFinishTime: "07:10" })],
    [wpAt(1), wpAt(2, 30), wpAt(3)],
    { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 18 },
  ));
}

// --- L4b pin geometry edges ---
async function genPinEdges() {
  section("L4b pin-geometry edges");
  const wps3 = [wpAt(1), wpAt(2, 15), wpAt(3)];
  await check("L4b/swapped", session([person("a", { startPin: atWp("w2"), finishPin: atWp("w1") }), person("b")], wps3, { intendedDistanceKm: 18 }));
  await check("L4b/finish-on-stop", session([person("a", { finishPin: atPlace(BASE.lat, BASE.lng + 0.03, "onstop") }), person("b")], wps3, { intendedDistanceKm: 18 }));
  await check("L4b/shared-finish", session([person("a", { finishPin: atWp("w3") }), person("b", { finishPin: atWp("w3") })], [wpAt(1), wpAt(2), wpAt(3, 15)], { intendedDistanceKm: 18 }));
  await check("L4b/maxExit-trim", session([person("a", { maxDistanceKm: 4 }), person("b", { maxDistanceKm: 4 })], [wpAt(1), wpAt(2), wpAt(3), wpAt(4, 15)], { intendedDistanceKm: 24 }));
}

// --- L5 four-wise conflict array (cap × lf × es × sp) ---
async function genConflict4() {
  section("L5 4-wise conflict");
  const cap4 = [null, 0.3, 5];
  const lf4 = [null, "07:20", "09:00"];
  const es4 = [null, "06:00", "09:00"];
  const sp4 = [auto, atWp("w1"), NEAR, FAR];
  const rows = coverN([cap4, lf4, es4, sp4].map((d) => d.map((_, i) => i)), 4);
  const wps3 = [wpAt(1), wpAt(2, 15), wpAt(3)];
  for (let ri = 0; ri < rows.length; ri += 3) {
    const people: Participant[] = [];
    for (let j = 0; j < 3; j++) {
      const row = rows[(ri + j) % rows.length];
      people.push(person(`p${j}`, {
        maxDistanceKm: cap4[row[0]],
        latestFinishTime: lf4[row[1]],
        earliestStartTime: es4[row[2]],
        startPin: sp4[row[3]] as LocationPin,
      }));
    }
    const s = session(people, wps3, { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 18 });
    await check(`L5/conflict4/r${ri}`, s);
  }
}

// --- L6 metamorphic relations ---
async function genMetamorphic() {
  section("L6 metamorphic");
  const wps3 = [wpAt(1), wpAt(2, 15), wpAt(3)];
  const seedFor = (): FlockSession =>
    session([person("a", { maxDistanceKm: 10 }), person("b", { pace: 480 }), person("c", { maxDistanceKm: 8 })], wps3, { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 18 });

  // MR-1 permute participant order (reverse)
  {
    curSig = "MR-1/permute";
    const s = seedFor();
    const r1 = await calculateRoutes(s);
    const s2 = session([...s.participants].reverse(), s.waypoints, { startAnchor: s.startAnchor, intendedDistanceKm: s.intendedDistanceKm });
    const r2 = await calculateRoutes(s2);
    okH(JSON.stringify(canon(r1)) === JSON.stringify(canon(r2)), `MR-1 permute changed canonical result`);
  }
  // MR-2 determinism (twice)
  {
    curSig = "MR-2/determinism";
    const s = seedFor();
    const r1 = await calculateRoutes(s);
    const r2 = await calculateRoutes(s);
    okH(JSON.stringify(r1) === JSON.stringify(r2), `MR-2 non-deterministic`);
  }
  // MR-5 scale all paces by k (dwell-free, connector-free, departure anchor, no es/lf)
  {
    curSig = "MR-5/pace-scale";
    const base = session([person("a", { pace: 360 }), person("b", { pace: 480 })], [wpAt(1), wpAt(2)], { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 12 });
    const k = 1.5;
    const scaled = session([person("a", { pace: 360 * k }), person("b", { pace: 480 * k })], base.waypoints, { startAnchor: base.startAnchor, intendedDistanceKm: base.intendedDistanceKm });
    const r1 = await calculateRoutes(base);
    const r2 = await calculateRoutes(scaled);
    const b1 = byId(r1), b2 = byId(r2);
    let distOk = true;
    for (const id of b1.keys()) if (Math.abs((b1.get(id)!.distanceKm) - (b2.get(id)!.distanceKm)) > 0.02) distOk = false;
    okH(distOk, `MR-5 distances changed under pace-scale`);
    okS(Math.abs(objOf(r2) - k * objOf(r1)) <= Math.max(0.05, 0.01 * k * objOf(r1)), `MR-5 obj ${round2(objOf(r2))} != k*${round2(objOf(r1))}`);
  }
  // MR-6 translate all coords by Δlng
  {
    curSig = "MR-6/translate";
    const s = seedFor();
    const d = 0.05;
    const wpsT = s.waypoints.map((w) => ({ ...w, location: { lat: w.location.lat, lng: w.location.lng + d } }));
    const s2 = session(s.participants, wpsT, { startAnchor: s.startAnchor, intendedDistanceKm: s.intendedDistanceKm });
    const r1 = await calculateRoutes(s);
    const r2 = await calculateRoutes(s2);
    const c1 = canon(r1), c2 = canon(r2);
    okH(JSON.stringify({ ...c1, routes: c1.routes.map((x) => ({ ...x })) }) ===
        JSON.stringify({ ...c2, routes: c2.routes.map((x) => ({ ...x })) }),
      `MR-6 translation changed scalars`);
  }
  // MR-4 add a zero-overlap runner; pre-existing pairs must not decrease
  {
    curSig = "MR-4/add-isolated";
    const s = seedFor();
    const r1 = await calculateRoutes(s);
    const x = person("z", { maxDistanceKm: 0.2, startPin: FAR, finishPin: FAR });
    const s2 = session([...s.participants, x], s.waypoints, { startAnchor: s.startAnchor, intendedDistanceKm: s.intendedDistanceKm });
    const r2 = await calculateRoutes(s2);
    const xTogether = r2.summary.pairwiseSummary.filter((p) => p.participantA === "z" || p.participantB === "z").reduce((s2, p) => s2 + p.togetherMinutes, 0);
    if (xTogether < 0.5) {
      const p1 = new Map(r1.summary.pairwiseSummary.map((p) => [pairKey(p.participantA, p.participantB), p.togetherMinutes]));
      let ok2 = true;
      for (const p of r2.summary.pairwiseSummary) {
        const k = pairKey(p.participantA, p.participantB);
        if (p1.has(k) && p.togetherMinutes < p1.get(k)! - 0.05) ok2 = false;
      }
      okH(ok2, `MR-4 pre-existing pair decreased after adding isolated runner`);
    } else okS(false, `MR-4 precondition not met (z overlapped ${round2(xTogether)})`);
  }
  // MR-15 raise a cap → that runner's together non-decreasing, no other pair decreases
  {
    curSig = "MR-15/raise-cap";
    const mk = (cap: number | null) => session([person("a", { maxDistanceKm: cap }), person("b"), person("c", { pace: 480 })], wps3, { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 18 });
    const r1 = await calculateRoutes(mk(4));
    const r2 = await calculateRoutes(mk(null));
    const pa1 = r1.summary.pairwiseSummary.filter((p) => p.participantA === "a" || p.participantB === "a").reduce((s, p) => s + p.togetherMinutes, 0);
    const pa2 = r2.summary.pairwiseSummary.filter((p) => p.participantA === "a" || p.participantB === "a").reduce((s, p) => s + p.togetherMinutes, 0);
    okS(pa2 >= pa1 - 0.06, `MR-15 raising cap reduced a's together ${round2(pa1)}→${round2(pa2)}`);
  }
  // MR-U / MR-Lk: unit + locked ignored
  {
    curSig = "MR-U-Lk/ignored";
    const s = seedFor();
    const r1 = await calculateRoutes(s);
    const r2 = await calculateRoutes(session(s.participants, s.waypoints, { startAnchor: s.startAnchor, intendedDistanceKm: s.intendedDistanceKm, unitPreference: "miles", lockedAt: "2026-01-01T00:00:00Z" }));
    okH(JSON.stringify(canon(r1)) === JSON.stringify(canon(r2)), `MR-U/Lk unit/locked changed result`);
  }
}

// --- L8 auto-start optimality sweep (SOFT) ---
async function genAutoStartSweep() {
  section("L8 auto-start optimality");
  const wps = [wpAt(1), wpAt(2, 15), wpAt(3), wpAt(4)];
  const seeds: FlockSession[] = [
    session([person("a", { maxDistanceKm: 4, latestFinishTime: "08:30" }), person("b"), person("c", { pace: 480 })], wps, { startAnchor: { kind: "auto" }, intendedDistanceKm: 24 }),
    session([person("a", { earliestStartTime: "08:00" }), person("b"), person("c", { latestFinishTime: "10:00" })], wps, { startAnchor: { kind: "auto" }, intendedDistanceKm: 24 }),
    session([person("a", { finishPin: atWp("w2"), latestFinishTime: "08:00" }), person("b", { pace: 600 })], wps, { startAnchor: { kind: "auto" }, intendedDistanceKm: 24 }),
  ];
  for (let si = 0; si < seeds.length; si++) {
    curSig = `L8/autostart/seed${si}`;
    const autoR = await calculateRoutes(seeds[si]);
    const autoObj = objOf(autoR);
    let best = autoObj, bestT = "auto";
    for (let g = 5 * 3600; g <= 10 * 3600; g += 300) {
      const t = `${String(Math.floor(g / 3600)).padStart(2, "0")}:${String(Math.floor((g % 3600) / 60)).padStart(2, "0")}`;
      const r = await calculateRoutes(session(seeds[si].participants, seeds[si].waypoints, { startAnchor: { kind: "departure", time: t }, intendedDistanceKm: seeds[si].intendedDistanceKm }));
      const o = objOf(r);
      if (o > best + 0.01) { best = o; bestT = t; }
    }
    okS(autoObj >= best - 1, `M3 auto obj ${round2(autoObj)} beaten by departure@${bestT} obj ${round2(best)} (−${round2(best - autoObj)})`);
  }
}

// --- L9 failure injection (the dead catch paths) ---
async function genFailureInjection() {
  section("L9 failure injection");
  const orig = globalThis.fetch;
  try {
    // (1) connector getRoute rejects → approach implicit, no throw, B3 holds
    curSig = "L9/connector-reject";
    globalThis.fetch = (async (u: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as { coordinates: [number, number][]; options?: { round_trip?: unknown } };
      // reject ONLY the connector request (one endpoint is the NEAR manual pin), never the
      // base corridor — so we exercise the connector catch path, not buildRoute's throw.
      if (!body.options?.round_trip && body.coordinates.some((c) => Math.abs(c[0] - (BASE.lng + 0.012)) < 1e-6))
        throw new Error("injected connector failure");
      return (orig as typeof fetch)(u as never, opts as never);
    }) as unknown as typeof fetch;
    await check("L9/connector-reject", session([person("a", { startPin: NEAR }), person("b")], [wpAt(1), wpAt(2)], { intendedDistanceKm: 12 }));
    // (2) grow round-trip rejects → corridor fallback
    curSig = "L9/grow-reject";
    globalThis.fetch = (async (u: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as { options?: { round_trip?: unknown } };
      if (body.options?.round_trip) throw new Error("injected grow failure");
      return (orig as typeof fetch)(u as never, opts as never);
    }) as unknown as typeof fetch;
    await check("L9/grow-reject", session([person("a"), person("b")], [wpAt(1), wpAt(2)], { intendedDistanceKm: 500 }));
  } finally {
    globalThis.fetch = orig;
  }
}

// --- L10 XFAIL / documented holes ---
async function genXfail() {
  section("L10 input guards (were XFAIL → now fixed) + deferred holes");
  const wps2 = [wpAt(1), wpAt(2)];
  // E35/E36 — pace 0 / negative / Infinity / NaN are finite-clamped (Step 5) → clean schedule.
  for (const pc of [0, -5, Infinity, NaN]) {
    curSig = `L10/pace=${pc}`;
    try {
      const r = await calculateRoutes(session([person("a", { pace: pc }), person("b")], wps2, { intendedDistanceKm: 12 }));
      const bad = r.routes.some((rt) => !isHHMM(rt.arrivalTime) || unwrap([rt.departureTime, rt.arrivalTime])[1] < unwrap([rt.departureTime, rt.arrivalTime])[0] - 1) || hasBadNumber(r);
      okH(!bad, `pace=${pc} produced invalid/inverted/non-finite schedule`);
    } catch (e) { okH(false, `pace=${pc} threw: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // negative-t0 — an early wp-anchor on a long route no longer wraps to evening (own-floor park).
  {
    curSig = "L10/negative-t0-wrap";
    const r = await calculateRoutes(session([person("a", { pace: 600 }), person("b", { pace: 600 })], [wpAt(1), wpAt(2), wpAt(3), wpAt(4)], { startAnchor: { kind: "waypoint", waypointId: "w4", time: "06:00" }, intendedDistanceKm: 24 }));
    const dep = r.routes[0]?.departureTime;
    okH(dep ? toSec(dep) <= 12 * 3600 : true, `negative-t0 rendered departure as ${dep} (expected early am)`);
  }
  // I4b — waypoint-anchor ETA drift with an UPSTREAM dwell: DEFERRED (Cause D), still XFAIL.
  {
    curSig = "L10/eta-drift";
    const r = await calculateRoutes(session([person("a"), person("b")], [wpAt(1, 20), wpAt(2)], { startAnchor: { kind: "waypoint", waypointId: "w2", time: "08:00" } }));
    const eta = r.waypointEtas?.["w2"];
    const drift = eta ? Math.abs(toSec(eta) - toSec("08:00")) : 0;
    okX(`I4b wp-anchor ETA drift with upstream dwell = ${eta} (drift ${drift}s) [Cause D deferred]`, drift > 60);
  }
}

// --- E1–E40 curated edge cases ---
async function genEdge() {
  section("L0 curated edge cases");
  await check("E1/0-participants", session([], [wpAt(1)]));
  await check("E2/W0-all-auto", session([person("a"), person("b")], []));
  await check("E3/1-runner", session([person("a")], [wpAt(1), wpAt(2)], { intendedDistanceKm: 12 }));
  await check("E4/W0-one-manual", session([person("a", { startPin: NEAR }), person("b")], []));
  await check("E5/coincident-wps", session([person("a"), person("b")], [wpAt(1), wp("w1b", BASE.lat, BASE.lng + 0.015, 0)], { intendedDistanceKm: 12 }));
  await check("E10/es>lf", session([person("a", { earliestStartTime: "09:00", latestFinishTime: "08:00" }), person("b")], [wpAt(1), wpAt(2)], { intendedDistanceKm: 12 }));
  await check("E13/es==lf", session([person("a", { earliestStartTime: "08:00", latestFinishTime: "08:00" }), person("b")], [wpAt(1), wpAt(2)], { intendedDistanceKm: 12 }));
  await check("E14/anchor-00:00", session([person("a"), person("b")], [wpAt(1), wpAt(2)], { startAnchor: { kind: "departure", time: "00:00" }, intendedDistanceKm: 12 }));
  await check("E20/finish-before-start", session([person("a", { startPin: atWp("w2"), finishPin: atWp("w1") }), person("b")], [wpAt(1), wpAt(2), wpAt(3)], { intendedDistanceKm: 18 }));
  await check("E22/unknown-wp-pin", session([person("a", { startPin: atWp("ghost") }), person("b")], [wpAt(1), wpAt(2)], { intendedDistanceKm: 12 }));
  await check("E23/anchor-vanished-wp", session([person("a"), person("b")], [wpAt(1), wpAt(2)], { startAnchor: { kind: "waypoint", waypointId: "ghost", time: "09:00" }, intendedDistanceKm: 12 }));
  await check("E32/18-runners", session(Array.from({ length: 18 }, (_, i) => person(`p${i}`)), [wpAt(1), wpAt(2)], { intendedDistanceKm: 12 }));
  await check("E37/everything-on-one", session([person("a", { startPin: NEAR, finishPin: atWp("w2"), maxDistanceKm: 6, earliestStartTime: "06:30", latestFinishTime: "09:00" }), person("b")], [wpAt(1), wpAt(2), wpAt(3)], { startAnchor: { kind: "waypoint", waypointId: "w1", time: "07:30" }, intendedDistanceKm: 18 }));
  // R-late/coarrival: a deadline runner pinned to a FAR waypoint the (fixed-start) flock only reaches
  // AFTER their latest finish must be PARKED (named) — never silently co-arrive late (the F2 wound on
  // the zero-arc co-arrival path). Fixed departure so auto-start can't rescue it. Oracle: G2 (line ~219)
  // catches a non-parked late arrival; after the fix the runner is parked (G2 exempt, "couldn't place").
  await check("R-late/coarrival", session([person("slow"), person("dl", { startPin: atWp("w5"), finishPin: atWp("w5"), latestFinishTime: "07:15" })], [wpAt(1), wpAt(2), wpAt(3), wpAt(4), wpAt(5)], { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 18 }));
  // R-earliest/long-approach-floor: a runner whose start is pinned far off-route (a long, unmovable
  // approach commute) WITH an earliest, on AUTO — the flock is DELAYED (the t0 floor) so they depart
  // no earlier than their earliest, instead of being dragged out early by the commute (Cause G).
  // The HARD G1 oracle (depart ≥ earliest for a feasible runner) asserts it.
  await check("R-earliest/long-approach-floor", session([person("far", { startPin: FAR, earliestStartTime: "08:00" }), person("b")], [wpAt(1), wpAt(2), wpAt(3)], { startAnchor: { kind: "auto" }, intendedDistanceKm: 18 }));
  // R-earliest/fixed-t0-parks: same far-pin + earliest but on a FIXED departure the flock can't wait
  // past — the flock sets off before they can, so they're PARKED (named), never silently dragged out
  // before earliest. G1 (HARD) holds because a parked runner is exempt; the curated lock is that no
  // feasible runner departs early. (Auto would delay the flock instead — see the scenario above.)
  await check("R-earliest/fixed-t0-parks", session([person("far", { startPin: FAR, earliestStartTime: "08:00" }), person("b")], [wpAt(1), wpAt(2), wpAt(3)], { startAnchor: { kind: "departure", time: "07:00" }, intendedDistanceKm: 18 }));
  // R-earliest/slow-companion: a far-pinned earliest runner WITH a much slower flock companion on auto.
  // Here d(depart)/d(t0) ≪ 1 (the slow companion drives block timing), so a Newton floor step under-
  // shoots and would WRONGLY earliest-park them; the bisection floor must delay enough that they RUN.
  // Oracles: G1 (depart≥earliest) + G3 (no auto earliest-park).
  await check("R-earliest/slow-companion", session([person("far", { startPin: FAR, earliestStartTime: "08:00" }), person("slow", { pace: 600 })], [wpAt(1), wpAt(2), wpAt(3)], { startAnchor: { kind: "auto" }, intendedDistanceKm: 18 }));
  // R-earliest/two-runners: two earliest runners, different paces + approaches, on auto — the floor must
  // satisfy the BINDING one; each departs ≥ its own earliest (G1) and neither is auto-parked (G3).
  await check("R-earliest/two-runners", session([person("p1", { startPin: NEAR, earliestStartTime: "07:30" }), person("p2", { startPin: FAR, earliestStartTime: "08:00", pace: 480 }), person("b")], [wpAt(1), wpAt(2), wpAt(3)], { startAnchor: { kind: "auto" }, intendedDistanceKm: 18 }));
  // R-earliest/early-deadline: a runner with an earliest AND a latest needing a pre-07:00 start, on auto.
  // The floor must NOT collapse onto 07:00 (which would latest-park them) — the sweep picks the early
  // start so they actually RUN (regression guard for the gap=-Infinity collapse).
  {
    const res = await check("R-earliest/early-deadline", session([person("x", { earliestStartTime: "05:30", latestFinishTime: "06:45" }), person("b")], [wpAt(1), wpAt(2)], { startAnchor: { kind: "auto" }, intendedDistanceKm: 12 }));
    if (res) {
      const x = res.routes.find((rt) => rt.participantId === "x")!;
      const xw = res.warnings.find((w) => w.participantId === "x");
      okH(!(xw && /couldn't place/.test(xw.message)) && x.distanceKm > 1, `R-earliest/early-deadline x must RUN via an early start (got dist ${round2(x.distanceKm)}, warn "${xw?.message ?? ""}")`);
    }
  }
}

// --- run all -----------------------------------------------------------------
async function main() {
  suite("combinatorial routing (calculateRoutes)");
  await genEdge();
  await genStructural();
  await genPairwise();
  await genTriple();
  await genBoundary();
  await genPinEdges();
  await genDwellArc();
  await genConflict4();
  await genMetamorphic();
  await genAutoStartSweep();
  await genFailureInjection();
  await genXfail();
}

function finishCombo() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`HARD:  ${hardPass} pass, ${hardFails.length} FAIL`);
  console.log(`SOFT:  ${softPass} pass, ${softFails.length} fail`);
  const xExpected = xfails.filter((x) => x.asExpected).length;
  console.log(`XFAIL: ${xfails.length} probes, ${xExpected} violated-as-expected, ${xfails.length - xExpected} unexpectedly-clean`);
  if (hardFails.length) {
    console.log(`\n── HARD FAILURES (grouped) ──`);
    const byInv = new Map<string, string[]>();
    for (const f of hardFails) {
      const id = f.split("—")[1]?.trim().split(/\s/)[0] ?? "?";
      (byInv.get(id) ?? byInv.set(id, []).get(id)!).push(f);
    }
    for (const [id, fs] of [...byInv.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  [${id}] ×${fs.length}`);
      for (const f of fs.slice(0, 8)) console.log(`    ✗ ${f}`);
      if (fs.length > 8) console.log(`    … +${fs.length - 8} more`);
    }
  }
  if (softFails.length) {
    console.log(`\n── SOFT signals (${softFails.length}) ──`);
    for (const f of softFails.slice(0, 30)) console.log(`    · ${f}`);
    if (softFails.length > 30) console.log(`    … +${softFails.length - 30} more`);
  }
  console.log(`\n── XFAIL digest ──`);
  for (const x of xfails) console.log(`    ${x.asExpected ? "✓ failed-as-expected" : "‼ UNEXPECTEDLY CLEAN"}  ${x.label}`);
  console.log(`\n${hardFails.length === 0 ? "✅ HARD ALL PASS" : `❌ ${hardFails.length} HARD FAILURES`}`);
  process.exit(hardFails.length ? 1 : 0);
}

main().then(finishCombo).catch((e) => { console.error("RUNNER CRASH", e); process.exit(2); });
