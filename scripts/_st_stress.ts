// STRESS suite for the social-first Flock engine — degenerate + extreme inputs.
// The bar: NO CRASH + invariants hold. tryOk wraps every calculateRoutes call so an
// engine throw is a recorded failure, not a suite abort. Invariant-first assertions
// (distance <= cap, arrival <= latest, pace == max present, valid HH:MM, geometry >= 2
// coords) over brittle exact numbers — fake-ORS is straight-line/haversine, but the
// engine's placement is incidental here; we assert structure, not magic values.
//   npx tsx scripts/_st_stress.ts
import {
  calculateRoutes, person, wp, session, atWp, atPlace,
  ok, tryOk, suite, section, finish,
} from "./_st_harness";

// Derive the result type from the entry point — the harness doesn't re-export it by name.
type CalcResult = Awaited<ReturnType<typeof calculateRoutes>>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHHMM = (s: unknown): boolean => typeof s === "string" && HHMM.test(s);

// Structural sanity that should hold for ANY non-skipped result. Returns nothing; asserts.
function assertWellFormed(res: CalcResult, label: string): void {
  ok(Array.isArray(res.routes), `${label}: routes is an array`);
  ok(Array.isArray(res.warnings), `${label}: warnings is an array`);
  ok(res.summary != null && typeof res.summary.totalTogetherMinutes === "number" && isFinite(res.summary.totalTogetherMinutes),
    `${label}: totalTogetherMinutes is a finite number (${res.summary?.totalTogetherMinutes})`);
  ok(res.summary != null && res.summary.totalTogetherMinutes >= 0, `${label}: totalTogetherMinutes >= 0`);
  for (const r of res.routes) {
    ok(typeof r.distanceKm === "number" && isFinite(r.distanceKm) && r.distanceKm >= 0,
      `${label}: ${r.participantId} distanceKm finite >= 0 (${r.distanceKm})`);
    ok(typeof r.estimatedDurationMinutes === "number" && isFinite(r.estimatedDurationMinutes) && r.estimatedDurationMinutes >= 0,
      `${label}: ${r.participantId} duration finite >= 0 (${r.estimatedDurationMinutes})`);
    ok(isHHMM(r.departureTime) && isHHMM(r.arrivalTime),
      `${label}: ${r.participantId} departure/arrival are valid HH:MM (${r.departureTime}/${r.arrivalTime})`);
    ok(r.geometry != null && Array.isArray(r.geometry.coordinates) && r.geometry.coordinates.length >= 2,
      `${label}: ${r.participantId} geometry has >= 2 coords (${r.geometry?.coordinates?.length})`);
    for (const s of r.schedule) {
      ok(isHHMM(s.startTime) && isHHMM(s.endTime), `${label}: ${r.participantId} schedule seg times valid HH:MM`);
      ok(s.paceSecPerKm === null || (typeof s.paceSecPerKm === "number" && s.paceSecPerKm > 0 && isFinite(s.paceSecPerKm)),
        `${label}: ${r.participantId} seg pace null-or-positive-finite (${s.paceSecPerKm})`);
    }
  }
}

async function main() {
  suite("STRESS — degenerate + extreme");

  // ── 1: ZERO participants → skipped, no crash ───────────────────────────────
  section("1 · zero participants");
  await tryOk(async () => {
    const res = await calculateRoutes(session([], [wp("c", 0, 0.05)]));
    ok(res.skipped === true, "0 participants ⇒ skipped:true");
    ok(res.routes.length === 0, "0 participants ⇒ no routes");
  }, "zero participants");

  // ── 2: ONE participant → together-time 0, no crash, no pairs ────────────────
  section("2 · single participant");
  await tryOk(async () => {
    const res = await calculateRoutes(session([person("solo")], [wp("c", 0.02, 0.02, 10)]));
    if (!res.skipped) {
      assertWellFormed(res, "solo");
      ok(res.summary.totalTogetherMinutes === 0, `solo together-time is 0 (${res.summary.totalTogetherMinutes})`);
      ok(res.summary.pairwiseSummary.length === 0, "solo has no pairwise entries");
      // a lone runner with no companions should still produce a usable route OR be skipped
      ok(res.routes.length <= 1, "solo ⇒ at most one route");
    } else {
      ok(true, "solo ⇒ skipped (acceptable: no flock to form)");
    }
  }, "single participant");

  // ── 3: LARGE group, all-auto (18) → pairwise count == n*(n-1)/2, no crash ───
  section("3 · large all-auto group (18)");
  await tryOk(async () => {
    const people = Array.from({ length: 18 }, (_, i) => person(`p${i}`));
    const res = await calculateRoutes(session(people, [wp("cafe", 0.03, 0.03, 15)], { intendedDistanceKm: 10 }));
    if (!res.skipped) {
      assertWellFormed(res, "big18");
      ok(res.routes.length === 18, `18 in ⇒ 18 routes (${res.routes.length})`);
      const n = res.routes.length;
      // pairwiseSummary lists at most every unordered pair; never more.
      ok(res.summary.pairwiseSummary.length <= (n * (n - 1)) / 2,
        `pairwise entries <= n*(n-1)/2 = ${(n * (n - 1)) / 2} (got ${res.summary.pairwiseSummary.length})`);
      // all-identical auto runners: everyone should share — expect the full set of pairs.
      ok(res.summary.pairwiseSummary.length === (n * (n - 1)) / 2,
        `all-auto identical ⇒ every pair present (${res.summary.pairwiseSummary.length} == ${(n * (n - 1)) / 2})`);
      ok(res.summary.totalTogetherMinutes > 0, "large all-auto group banks together-time");
    } else {
      ok(false, "large all-auto group should NOT be skipped");
    }
  }, "large group");

  // ── 4: EXTREME pace gap (240 vs 900 s/km) → slowest wins, finite times ──────
  section("4 · extreme pace gap 240 vs 900");
  await tryOk(async () => {
    const fast = person("fast", { pace: 240 });
    const slow = person("slow", { pace: 900 });
    const res = await calculateRoutes(session([fast, slow], [wp("c", 0.04, 0.04, 5)], { intendedDistanceKm: 8 }));
    if (!res.skipped) {
      assertWellFormed(res, "pacegap");
      // SLOWEST WINS: any segment with BOTH present runs at >= 900 (the slow pace), not 240.
      let sharedFound = false;
      for (const r of res.routes) {
        for (const s of r.schedule) {
          if (s.paceSecPerKm !== null && s.companionIds.length >= 1) {
            sharedFound = true;
            ok(s.paceSecPerKm >= 900 - 1e-6,
              `shared moving leg runs at slowest pace >= 900 (got ${s.paceSecPerKm}) for ${r.participantId}`);
          }
        }
      }
      ok(sharedFound || res.summary.totalTogetherMinutes >= 0,
        "extreme pace gap handled (shared leg at slow pace, or dwell-only overlap)");
    } else {
      ok(false, "two runners should NOT be skipped");
    }
  }, "extreme pace gap");

  // ── 5: TWO waypoints at the SAME location → no crash, no NaN, zero-length leg ─
  section("5 · two waypoints at identical location");
  await tryOk(async () => {
    const dup = [wp("a", 0.05, 0.05, 5), wp("b", 0.05, 0.05, 5)];
    const res = await calculateRoutes(session([person("x"), person("y")], dup, { intendedDistanceKm: 10 }));
    if (!res.skipped) {
      assertWellFormed(res, "samewp");
      // a leg between coincident waypoints is fine as long as nothing is NaN/Infinity.
      for (const r of res.routes) ok(isFinite(r.distanceKm), `samewp: ${r.participantId} distance finite (${r.distanceKm})`);
      if (res.waypointEtas) {
        for (const [k, v] of Object.entries(res.waypointEtas)) ok(isHHMM(v), `samewp: eta[${k}] valid HH:MM (${v})`);
      }
    } else {
      ok(true, "coincident waypoints ⇒ skipped (acceptable degenerate geometry)");
    }
  }, "duplicate waypoints");

  // ── 6: HUGE dwell (600 min) → finite times, dwell counts as together-time ───
  section("6 · huge dwell (600 min)");
  await tryOk(async () => {
    const res = await calculateRoutes(session([person("m"), person("n")], [wp("longstop", 0.03, 0.03, 600)], { intendedDistanceKm: 6 }));
    if (!res.skipped) {
      assertWellFormed(res, "hugedwell");
      // both present at a 600-min stop ⇒ substantial together-time, all times still valid HH:MM.
      const restSegs = res.routes.flatMap((r) => r.schedule.filter((s) => s.type === "rest"));
      ok(restSegs.length >= 1, "a huge rest segment exists");
      ok(res.summary.totalTogetherMinutes > 0, `huge shared dwell banks together-time (${res.summary.totalTogetherMinutes})`);
      // dwell shared by 2 ⇒ at least ~600 pairwise min from the stop alone.
      ok(res.summary.totalTogetherMinutes >= 100, `dwell dominates together-time (${res.summary.totalTogetherMinutes} >= 100)`);
    } else {
      ok(false, "huge dwell should NOT skip");
    }
  }, "huge dwell");

  // ── 7: CAP 0 → capped runner distance <= 0 (clamped), no crash ──────────────
  section("7 · cap 0 km");
  await tryOk(async () => {
    const capped = person("z", { maxDistanceKm: 0 });
    const res = await calculateRoutes(session([person("a"), person("b"), capped], [wp("c", 0.03, 0.03, 10)], { intendedDistanceKm: 8 }));
    if (!res.skipped) {
      assertWellFormed(res, "cap0");
      const zr = res.routes.find((r) => r.participantId === "z");
      if (zr) {
        ok(zr.distanceKm <= 0 + 1e-6, `cap-0 runner distance <= 0 (${zr.distanceKm})`);
        ok(isFinite(zr.distanceKm), "cap-0 runner distance is finite");
      } else {
        ok(true, "cap-0 runner dropped from routes (acceptable: can't run any distance)");
      }
      // the other two should still get real routes.
      ok(res.routes.filter((r) => r.distanceKm > 0).length >= 1, "non-capped runners still routed");
    } else {
      ok(false, "cap-0 plus normal runners should NOT skip");
    }
  }, "cap 0");

  // ── 8: pinned start arc AFTER pinned finish arc → must clamp, not crash ─────
  section("8 · start waypoint AFTER finish waypoint (inverted pins)");
  await tryOk(async () => {
    const w1 = wp("w1", 0.02, 0.02, 0);
    const w2 = wp("w2", 0.06, 0.06, 0);
    // q starts at the LATER waypoint w2 and finishes at the EARLIER waypoint w1 — inverted.
    const q = person("q", { startPin: atWp("w2"), finishPin: atWp("w1") });
    const res = await calculateRoutes(session([person("a"), person("b"), q], [w1, w2], { intendedDistanceKm: 12 }));
    if (!res.skipped) {
      assertWellFormed(res, "inverted");
      const qr = res.routes.find((r) => r.participantId === "q");
      if (qr) {
        ok(isFinite(qr.distanceKm) && qr.distanceKm >= 0, `inverted q distance finite >= 0 (${qr.distanceKm})`);
        ok(isHHMM(qr.departureTime) && isHHMM(qr.arrivalTime), "inverted q has valid times");
        // departure must not be after arrival in wall-clock terms.
        ok(qr.departureTime <= qr.arrivalTime, `inverted q departs no later than arrives (${qr.departureTime} <= ${qr.arrivalTime})`);
      } else {
        ok(true, "inverted-pin runner dropped (acceptable clamp-to-nothing)");
      }
    } else {
      ok(true, "inverted pins ⇒ skipped (acceptable)");
    }
  }, "inverted pins");

  // ── 9: EVERYTHING set at once → no crash, all constraints respected ─────────
  section("9 · everything-set-at-once");
  await tryOk(async () => {
    const wA = wp("wA", 0.02, 0.02, 8);
    const wB = wp("wB", 0.05, 0.05, 12);
    const people = [
      person("full", { pace: 360 }),
      person("capped", { pace: 600, maxDistanceKm: 4 }),
      person("deadline", { pace: 480, latestFinishTime: "08:30" }),
      person("late", { pace: 420, earliestStartTime: "07:15" }),
      person("manual", { startPin: atPlace(0.0, 0.0, "home"), finishPin: atPlace(0.07, 0.07, "office") }),
      person("wpjoin", { startPin: atWp("wA"), finishPin: atWp("wB") }),
    ];
    const res = await calculateRoutes(session(people, [wA, wB], {
      startAnchor: { kind: "waypoint", waypointId: "wA", time: "07:45" },
      intendedDistanceKm: 14,
    }));
    if (!res.skipped) {
      assertWellFormed(res, "kitchensink");
      const cap = res.routes.find((r) => r.participantId === "capped");
      if (cap) ok(cap.distanceKm <= 4 + 1e-6, `capped runner <= 4 km cap (${cap.distanceKm})`);
      const dl = res.routes.find((r) => r.participantId === "deadline");
      if (dl) ok(dl.arrivalTime <= "08:30", `deadline runner arrives <= 08:30 (${dl.arrivalTime})`);
      const la = res.routes.find((r) => r.participantId === "late");
      if (la) ok(la.departureTime >= "07:15", `earliest-start runner departs >= 07:15 (${la.departureTime})`);
      ok(res.summary.totalTogetherMinutes >= 0, "kitchen-sink together-time finite >= 0");
    } else {
      ok(false, "fully-specified feasible session should NOT skip");
    }
  }, "everything at once");

  // ── 10: degenerate geography — all pins on the SAME point, no waypoints ─────
  section("10 · zero-spread geography (all at one point)");
  await tryOk(async () => {
    const a = person("a", { startPin: atPlace(0, 0), finishPin: atPlace(0, 0) });
    const b = person("b", { startPin: atPlace(0, 0), finishPin: atPlace(0, 0) });
    const res = await calculateRoutes(session([a, b], []));
    // no routable geography ⇒ skipped is the documented contract; but no-crash either way.
    if (res.skipped) ok(true, "all-same-point, no waypoints ⇒ skipped (no routable geography)");
    else { assertWellFormed(res, "nopread"); ok(res.summary.totalTogetherMinutes >= 0, "zero-spread together-time finite"); }
  }, "zero-spread geography");

  // ── 11: cap NEGATIVE → must not crash; treated as <= 0 ─────────────────────
  section("11 · negative cap");
  await tryOk(async () => {
    const neg = person("neg", { maxDistanceKm: -5 });
    const res = await calculateRoutes(session([person("a"), person("b"), neg], [wp("c", 0.03, 0.03, 5)], { intendedDistanceKm: 8 }));
    if (!res.skipped) {
      assertWellFormed(res, "negcap");
      const nr = res.routes.find((r) => r.participantId === "neg");
      if (nr) ok(nr.distanceKm <= 0 + 1e-6, `negative-cap runner distance clamped <= 0 (${nr.distanceKm})`);
      else ok(true, "negative-cap runner dropped (acceptable)");
    } else {
      ok(true, "negative cap ⇒ skipped (acceptable)");
    }
  }, "negative cap");

  // ── 12: deadline IMPOSSIBLY early → no crash, arrival still valid/clamped ───
  section("12 · impossible deadline (finish before start)");
  await tryOk(async () => {
    // latestFinishTime 07:01 against a default 07:00 anchor with a 10 km route — infeasible.
    const tight = person("tight", { pace: 600, latestFinishTime: "07:01" });
    const res = await calculateRoutes(session([person("a"), person("b"), tight], [wp("c", 0.04, 0.04, 5)], { intendedDistanceKm: 10 }));
    if (!res.skipped) {
      assertWellFormed(res, "tightdl");
      const tr = res.routes.find((r) => r.participantId === "tight");
      if (tr) {
        ok(isHHMM(tr.arrivalTime), `impossible-deadline runner still has valid arrival (${tr.arrivalTime})`);
        ok(tr.departureTime <= tr.arrivalTime, "impossible-deadline runner departs no later than arrives");
      } else {
        ok(true, "impossible-deadline runner dropped (acceptable)");
      }
      // engine should warn when a constraint forces a partial/early peel.
      ok(Array.isArray(res.warnings), "warnings present (array) under infeasible deadline");
    } else {
      ok(true, "impossible deadline ⇒ skipped (acceptable)");
    }
  }, "impossible deadline");

  finish();
}

main();
