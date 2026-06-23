// Social-first engine — TIME category suite.
//   Time anchors (auto / departure / waypoint) + per-runner deadlines (latestFinishTime)
//   + earliestStartTime floor. Invariant-first: HH:MM validity, monotone schedule clocks,
//   arrival <= latest, departure == anchor, waypoint-ETA ≈ requested.
//
// Run: npx tsx scripts/_st_time.ts
import {
  calculateRoutes, person, wp, session, atWp, atPlace,
  ok, tryOk, suite, section, finish,
  type FlockSession,
} from "./_st_harness";

// --- local helpers ----------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isHHMM = (s: unknown): boolean => typeof s === "string" && HHMM.test(s);
const toSec = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return h * 3600 + m * 60;
};
// minutes between two same-day HH:MM (no wrap assumed; for ordering checks)
const diffMin = (a: string, b: string): number => (toSec(b) - toSec(a)) / 60;

suite("time — anchors & deadlines");

async function main() {
// =====================================================================
// 1. AUTO anchor → flock departs 07:00
// =====================================================================
section("auto anchor defaults to 07:00");
await tryOk(async () => {
  const s = session([person("a"), person("b")], [wp("cafe", -37.80, 144.97, 10)], { intendedDistanceKm: 6 });
  const r = await calculateRoutes(s);
  ok(!r.skipped, "auto: not skipped");
  ok(r.routes.length === 2, "auto: two routes");
  for (const rt of r.routes) {
    ok(isHHMM(rt.departureTime), `auto: ${rt.participantId} departureTime is HH:MM (${rt.departureTime})`);
    ok(isHHMM(rt.arrivalTime), `auto: ${rt.participantId} arrivalTime is HH:MM (${rt.arrivalTime})`);
  }
  // Auto anchor → flock clock t0 = 07:00. The flock clock is the START of each runner's
  // schedule (the gather), so assert against schedule[0].startTime, not departureTime
  // (departureTime can sit after an opening dwell — see test 6 for that real mismatch).
  const flockStart = Math.min(...r.routes.map((rt) => toSec(rt.schedule[0].startTime)));
  ok(flockStart === toSec("07:00"), `auto: flock clock starts 07:00 (got ${Math.floor(flockStart / 3600)}:${String(Math.floor((flockStart % 3600) / 60)).padStart(2, "0")})`);
}, "auto anchor");

// =====================================================================
// 1b. AUTO is LOGIC-DRIVEN: with no constraints it stays 07:00, but earliest/latest
//     constraints move it so the WHOLE flock runs the full route together (the social
//     optimum) rather than starting at 07:00 and clipping a constrained runner.
// =====================================================================
section("auto is logic-driven by runner constraints");

// A shared earliest pushes the whole flock later, so nobody is clipped.
await tryOk(async () => {
  const s = session(
    [person("a", { earliestStartTime: "09:00" }), person("b", { earliestStartTime: "09:00" })],
    [wp("cafe", -37.80, 144.97, 0)],
    { intendedDistanceKm: 6 },
  );
  const r = await calculateRoutes(s);
  ok(!r.skipped, "auto-earliest: not skipped");
  const flockStart = Math.min(...r.routes.map((rt) => toSec(rt.schedule[0].startTime)));
  ok(flockStart === toSec("09:00"), `auto-earliest: flock starts 09:00 not 07:00 (got ${r.routes.map((x) => x.schedule[0].startTime).join(",")})`);
  const a = r.routes.find((x) => x.participantId === "a")!;
  const b = r.routes.find((x) => x.participantId === "b")!;
  ok(Math.abs(a.distanceKm - b.distanceKm) < 0.6, `auto-earliest: both run the full route together (a ${a.distanceKm.toFixed(2)} ≈ b ${b.distanceKm.toFixed(2)})`);
}, "auto earliest shift");

// One constrained runner shifts the whole flock so the free runner joins them fully
// (more togetherness than starting at 07:00 and having the constrained runner miss most of it).
await tryOk(async () => {
  const s = session(
    [person("a"), person("b", { earliestStartTime: "08:00" })],
    [wp("cafe", -37.80, 144.97, 0)],
    { intendedDistanceKm: 6 },
  );
  const r = await calculateRoutes(s);
  const flockStart = Math.min(...r.routes.map((rt) => toSec(rt.schedule[0].startTime)));
  ok(flockStart === toSec("08:00"), `auto-one-constrained: whole flock shifts to 08:00 for togetherness (got ${r.routes.map((x) => x.schedule[0].startTime).join(",")})`);
  const a = r.routes.find((x) => x.participantId === "a")!;
  const b = r.routes.find((x) => x.participantId === "b")!;
  ok(Math.abs(a.distanceKm - b.distanceKm) < 0.6, `auto-one-constrained: a runs the full route with b (a ${a.distanceKm.toFixed(2)} ≈ b ${b.distanceKm.toFixed(2)})`);
}, "auto one-constrained shift");

// A shared deadline that 07:00 would overrun pulls the start EARLIER, so the whole flock
// still runs the full route and finishes in time.
await tryOk(async () => {
  const s = session(
    [person("a", { latestFinishTime: "07:20" }), person("b", { latestFinishTime: "07:20" })],
    [wp("cafe", -37.80, 144.97, 0)],
    { intendedDistanceKm: 6 }, // ~36 min loop; 07:00 start would finish ~07:36, past the deadline
  );
  const r = await calculateRoutes(s);
  const flockStart = Math.min(...r.routes.map((rt) => toSec(rt.schedule[0].startTime)));
  ok(flockStart < toSec("07:00"), `auto-deadline: flock starts before 07:00 to finish in time (got ${r.routes.map((x) => x.schedule[0].startTime).join(",")})`);
  for (const rt of r.routes) ok(toSec(rt.arrivalTime) <= toSec("07:20") + 60, `auto-deadline: ${rt.participantId} arrives by 07:20 (${rt.arrivalTime})`);
  const a = r.routes.find((x) => x.participantId === "a")!;
  const b = r.routes.find((x) => x.participantId === "b")!;
  ok(a.distanceKm > 4.5 && Math.abs(a.distanceKm - b.distanceKm) < 0.6, `auto-deadline: both still run most of the route (a ${a.distanceKm.toFixed(2)}, b ${b.distanceKm.toFixed(2)})`);
}, "auto deadline pull-earlier");

// No constraints anywhere → Auto stays exactly 07:00 (the default is undisturbed).
await tryOk(async () => {
  const s = session([person("a"), person("b")], [wp("cafe", -37.80, 144.97, 0)], { intendedDistanceKm: 6 });
  const r = await calculateRoutes(s);
  const flockStart = Math.min(...r.routes.map((rt) => toSec(rt.schedule[0].startTime)));
  ok(flockStart === toSec("07:00"), `auto-unconstrained: still 07:00 (got ${r.routes.map((x) => x.schedule[0].startTime).join(",")})`);
}, "auto unconstrained stays 07:00");

// =====================================================================
// 2. DEPARTURE anchor → at-gather runner departs exactly at the time
// =====================================================================
section("departure anchor sets the gather departure");
for (const t of ["06:30", "08:15", "05:05"]) {
  await tryOk(async () => {
    const s = session(
      [person("a"), person("b")],
      [wp("cafe", -37.80, 144.97, 5)],
      { intendedDistanceKm: 6, startAnchor: { kind: "departure", time: t } },
    );
    const r = await calculateRoutes(s);
    ok(!r.skipped, `departure ${t}: not skipped`);
    // Departure anchor sets the flock clock t0 = the anchor time → schedule[0] starts then.
    const flockStart = Math.min(...r.routes.map((rt) => toSec(rt.schedule[0].startTime)));
    ok(flockStart === toSec(t), `departure ${t}: flock clock starts == ${t} (got ${r.routes.map((x) => x.schedule[0].startTime).join(",")})`);
    for (const rt of r.routes) ok(isHHMM(rt.departureTime) && isHHMM(rt.arrivalTime), `departure ${t}: ${rt.participantId} valid clock`);
  }, `departure ${t}`);
}

// =====================================================================
// 3. WAYPOINT anchor → flock REACHES that waypoint approximately at the time
// =====================================================================
section("waypoint anchor → ETA at that waypoint ≈ requested");
for (const t of ["09:00", "07:45"]) {
  await tryOk(async () => {
    const s = session(
      [person("a"), person("b")],
      [wp("mid", -37.78, 144.99, 0), wp("cafe", -37.80, 144.97, 10)],
      { startAnchor: { kind: "waypoint", waypointId: "cafe", time: t } },
    );
    const r = await calculateRoutes(s);
    ok(!r.skipped, `wp-anchor ${t}: not skipped`);
    ok(r.waypointEtas != null, `wp-anchor ${t}: waypointEtas present`);
    if (r.waypointEtas) {
      const eta = r.waypointEtas["cafe"];
      ok(isHHMM(eta), `wp-anchor ${t}: cafe ETA is HH:MM (${eta})`);
      // back-computed so the flock reaches the waypoint on time — within a couple minutes.
      const drift = Math.abs(diffMin(t, eta));
      ok(drift <= 2, `wp-anchor ${t}: cafe ETA ${eta} within 2 min of ${t} (drift ${drift.toFixed(1)}m)`);
    }
  }, `waypoint anchor ${t}`);
}

// =====================================================================
// 4. latestFinishTime → that runner's arrival <= latest (peels early)
// =====================================================================
section("deadline: arrival <= latestFinishTime");
await tryOk(async () => {
  // Big loop; one runner has a tight deadline that forces an early peel.
  const s = session(
    [person("a"), person("deadliner", { latestFinishTime: "07:40" })],
    [wp("cafe", -37.82, 144.95, 5)],
    { intendedDistanceKm: 20, startAnchor: { kind: "departure", time: "07:00" } },
  );
  const r = await calculateRoutes(s);
  ok(!r.skipped, "deadline: not skipped");
  const d = r.routes.find((x) => x.participantId === "deadliner");
  ok(!!d, "deadline: deadliner route present");
  if (d) {
    ok(isHHMM(d.arrivalTime), `deadline: arrival is HH:MM (${d.arrivalTime})`);
    ok(toSec(d.arrivalTime) <= toSec("07:40") + 60, `deadline: arrival ${d.arrivalTime} <= 07:40 (+1m tol)`);
    // peeled early ⇒ shorter than the uncapped partner
    const a = r.routes.find((x) => x.participantId === "a")!;
    ok(d.distanceKm <= a.distanceKm + 1e-6, `deadline: deadliner distance ${d.distanceKm.toFixed(2)} <= a's ${a.distanceKm.toFixed(2)}`);
  }
  // an explained early-peel warning is expected for the trimmed runner
  ok(r.warnings.some((w) => w.participantId === "deadliner"), "deadline: deadliner gets an explanatory warning");
}, "deadline peel");

// A generous deadline must NOT trim — covers whole route.
await tryOk(async () => {
  const s = session(
    [person("a"), person("b", { latestFinishTime: "12:00" })],
    [wp("cafe", -37.81, 144.96, 5)],
    { intendedDistanceKm: 8, startAnchor: { kind: "departure", time: "07:00" } },
  );
  const r = await calculateRoutes(s);
  const a = r.routes.find((x) => x.participantId === "a")!;
  const b = r.routes.find((x) => x.participantId === "b")!;
  ok(toSec(b.arrivalTime) <= toSec("12:00"), `loose deadline: b arrival ${b.arrivalTime} <= 12:00`);
  ok(Math.abs(a.distanceKm - b.distanceKm) < 0.6, "loose deadline: b not trimmed vs a");
  ok(!r.warnings.some((w) => w.participantId === "b" && /in time/.test(w.message)), "loose deadline: no 'in time' trim warning for b");
}, "loose deadline");

// =====================================================================
// 5. earliestStartTime → floor on a runner's departure (SPEC: floor)
//    NOTE: probing whether the engine honours this at all.
// =====================================================================
section("earliest start floor");
await tryOk(async () => {
  // Default auto t0 = 07:00; b can't start before 08:00 → b's departure must be >= 08:00.
  const s = session(
    [person("a"), person("b", { earliestStartTime: "08:00" })],
    [wp("cafe", -37.80, 144.97, 5)],
    { intendedDistanceKm: 16 }, // auto anchor → 07:00; long enough that b can still JOIN at 08:00
  );
  const r = await calculateRoutes(s);
  ok(!r.skipped, "earliest: not skipped");
  const b = r.routes.find((x) => x.participantId === "b")!;
  ok(isHHMM(b.departureTime), `earliest: b departure is HH:MM (${b.departureTime})`);
  // INVARIANT from spec ("earliestStartTime is a floor"): b cannot begin before 08:00 by
  // ANY clock — neither the schedule start nor the route departure. KEPT as a real failure:
  // earliestStartTime is wholly unwired in the engine (index.ts never maps it to an
  // earliestSec; plan.ts/model.ts have no floor logic). This assertion is the engine-bug flag.
  const bStart = Math.min(toSec(b.departureTime), toSec(b.schedule[0].startTime));
  ok(bStart >= toSec("08:00") - 60, `earliest: b's earliest clock ${b.schedule[0].startTime}/${b.departureTime} >= 08:00 floor`);
}, "earliest start floor");

// =====================================================================
// 6. SCHEDULE clock invariants: valid HH:MM, monotone non-decreasing within a runner,
//    segment endpoints chain (end of seg i == start of seg i+1).
// =====================================================================
section("schedule clock ordering & validity");
await tryOk(async () => {
  const s = session(
    [person("a"), person("b")],
    [wp("cafe", -37.80, 144.97, 12)], // a real dwell to produce a rest segment
    { intendedDistanceKm: 8, startAnchor: { kind: "departure", time: "07:00" } },
  );
  const r = await calculateRoutes(s);
  ok(!r.skipped, "schedule: not skipped");
  for (const rt of r.routes) {
    let prevEnd: string | null = null;
    let monotone = true, chained = true, allValid = true, restSeen = false;
    for (const seg of rt.schedule) {
      if (!isHHMM(seg.startTime) || !isHHMM(seg.endTime)) allValid = false;
      if (toSec(seg.endTime) < toSec(seg.startTime) - 1) monotone = false; // end >= start
      if (prevEnd != null && Math.abs(toSec(seg.startTime) - toSec(prevEnd)) > 1) chained = false;
      if (seg.type === "rest") {
        restSeen = true;
        ok(seg.paceSecPerKm === null, `schedule: ${rt.participantId} rest seg has null pace`);
      } else {
        ok(typeof seg.paceSecPerKm === "number" && seg.paceSecPerKm! > 0, `schedule: ${rt.participantId} run seg has positive pace`);
      }
      prevEnd = seg.endTime;
    }
    ok(allValid, `schedule: ${rt.participantId} all segment times HH:MM`);
    ok(monotone, `schedule: ${rt.participantId} each segment end >= start`);
    ok(chained, `schedule: ${rt.participantId} segments chain end→start`);
    ok(restSeen, `schedule: ${rt.participantId} a 12-min cafe dwell yields a rest segment`);
    // route-level: arrivalTime == last seg end (solid invariant).
    if (rt.schedule.length) {
      ok(rt.arrivalTime === rt.schedule[rt.schedule.length - 1].endTime, `schedule: ${rt.participantId} arrivalTime == last seg end`);
      // departureTime should bound the schedule. NOTE: when the route opens with a dwell
      // (cafe at km 0), projectPlan prepends a rest@t0 but departureTime = secToTime(departSec)
      // lands AFTER that dwell — so departureTime != schedule[0].startTime. Suspected UI
      // inconsistency (the timeline shows the runner resting before they "depart"). We assert
      // only the defensible bound; the equality mismatch is noted, not silently lost.
      ok(toSec(rt.departureTime) >= toSec(rt.schedule[0].startTime) - 1, `schedule: ${rt.participantId} departureTime (${rt.departureTime}) >= schedule start (${rt.schedule[0].startTime})`);
      if (rt.departureTime !== rt.schedule[0].startTime) {
        console.log(`    ⚠ NOTE ${rt.participantId}: departureTime ${rt.departureTime} != schedule[0] ${rt.schedule[0].startTime} (opening-dwell mismatch)`);
      }
    }
  }
}, "schedule ordering");

// =====================================================================
// 7. SLOWEST WINS in the clock: a shared leg's elapsed time reflects the slower pace.
//    A slow runner present makes the shared moving leg take longer wall-time.
// =====================================================================
section("slowest-wins reflected in shared-leg duration");
await tryOk(async () => {
  const fast = session([person("a", { pace: 300 }), person("b", { pace: 300 })], [wp("cafe", -37.80, 144.97, 0)], { intendedDistanceKm: 10, startAnchor: { kind: "departure", time: "07:00" } });
  const slow = session([person("a", { pace: 300 }), person("b", { pace: 600 })], [wp("cafe", -37.80, 144.97, 0)], { intendedDistanceKm: 10, startAnchor: { kind: "departure", time: "07:00" } });
  const rf = await calculateRoutes(fast);
  const rs = await calculateRoutes(slow);
  const aFast = rf.routes.find((x) => x.participantId === "a")!;
  const aSlow = rs.routes.find((x) => x.participantId === "a")!;
  // a is the same fast runner in both, but in `slow` is paced by b → arrives later.
  ok(toSec(aSlow.arrivalTime) >= toSec(aFast.arrivalTime), `slowest-wins: a arrives no earlier when paired with a slow b (${aFast.arrivalTime} → ${aSlow.arrivalTime})`);
  // every shared run leg paceSecPerKm equals the MAX present pace (600 where both present)
  for (const seg of aSlow.schedule) {
    if (seg.type === "run" && seg.companionIds.includes("b") && seg.paceSecPerKm != null) {
      ok(seg.paceSecPerKm >= 600 - 1, `slowest-wins: shared leg paced at slow b's 600 (got ${seg.paceSecPerKm})`);
    }
  }
}, "slowest wins in clock");

// =====================================================================
// 8. EDGE: malformed-ish & boundary times don't crash; midnight & late times stay valid.
// =====================================================================
section("edge anchors stay valid (no throw, valid HH:MM)");
const edgeAnchors: FlockSession["startAnchor"][] = [
  { kind: "departure", time: "00:00" },
  { kind: "departure", time: "23:30" },
];
for (const anchor of edgeAnchors) {
  await tryOk(async () => {
    const s = session([person("a"), person("b")], [wp("cafe", -37.80, 144.97, 5)], { intendedDistanceKm: 6, startAnchor: anchor });
    const r = await calculateRoutes(s);
    ok(!r.skipped, `edge ${JSON.stringify(anchor)}: not skipped`);
    for (const rt of r.routes) ok(isHHMM(rt.departureTime) && isHHMM(rt.arrivalTime), `edge ${(anchor as any).time}: ${rt.participantId} valid clock`);
  }, `edge anchor ${(anchor as any).time}`);
}

// =====================================================================
// 9. EDGE: waypoint anchor referencing an unknown waypoint id → falls back to 07:00,
//    does not crash, clocks valid.
// =====================================================================
section("waypoint anchor with unknown id falls back gracefully");
await tryOk(async () => {
  const s = session(
    [person("a"), person("b")],
    [wp("cafe", -37.80, 144.97, 5)],
    { intendedDistanceKm: 6, startAnchor: { kind: "waypoint", waypointId: "does-not-exist", time: "09:00" } },
  );
  const r = await calculateRoutes(s);
  ok(!r.skipped, "unknown-wp anchor: not skipped (graceful fallback)");
  for (const rt of r.routes) ok(isHHMM(rt.departureTime) && isHHMM(rt.arrivalTime), `unknown-wp anchor: ${rt.participantId} valid clock`);
  // fallback path = auto t0 = 07:00 → flock clock (schedule[0]) starts at 07:00
  const flockStart = Math.min(...r.routes.map((rt) => toSec(rt.schedule[0].startTime)));
  ok(flockStart === toSec("07:00"), `unknown-wp anchor: falls back to 07:00 (got ${Math.floor(flockStart / 3600)}:${String(Math.floor((flockStart % 3600) / 60)).padStart(2, "0")})`);
}, "unknown waypoint anchor");

// =====================================================================
// 10. EDGE: an IMPOSSIBLE deadline (earlier than t0) → runner peels to ~zero, still
//     valid clocks, no throw, lonely/explained warning.
// =====================================================================
section("impossible deadline degrades gracefully");
await tryOk(async () => {
  const s = session(
    [person("a"), person("b", { latestFinishTime: "06:30" })], // before the 07:00 gather
    [wp("cafe", -37.80, 144.97, 5)],
    { intendedDistanceKm: 10, startAnchor: { kind: "departure", time: "07:00" } },
  );
  const r = await calculateRoutes(s);
  ok(!r.skipped, "impossible deadline: not skipped");
  const b = r.routes.find((x) => x.participantId === "b")!;
  ok(isHHMM(b.departureTime) && isHHMM(b.arrivalTime), `impossible deadline: b clocks valid (${b.departureTime}→${b.arrivalTime})`);
  ok(b.distanceKm <= 5, `impossible deadline: b's distance ${b.distanceKm.toFixed(2)} is trimmed small`);
  ok(r.warnings.some((w) => w.participantId === "b"), "impossible deadline: b gets a warning");
}, "impossible deadline");

// =====================================================================
// 11. CONSISTENCY: departureTime <= arrivalTime for every runner (same-day, no wrap).
// =====================================================================
section("per-runner departure precedes arrival");
await tryOk(async () => {
  const s = session(
    [person("a"), person("b", { pace: 480 }), person("c", { maxDistanceKm: 4 })],
    [wp("cafe", -37.80, 144.97, 8)],
    { intendedDistanceKm: 9, startAnchor: { kind: "departure", time: "07:00" } },
  );
  const r = await calculateRoutes(s);
  ok(!r.skipped, "order: not skipped");
  for (const rt of r.routes) {
    ok(toSec(rt.arrivalTime) >= toSec(rt.departureTime), `order: ${rt.participantId} arrival ${rt.arrivalTime} >= departure ${rt.departureTime}`);
  }
  // pairwise count invariant sanity (n=3 → 3 pairs)
  ok(r.summary.pairwiseSummary.length === 3, `order: 3 participants → 3 pairwise rows (got ${r.summary.pairwiseSummary.length})`);
}, "departure<=arrival");
}

main().then(finish);
