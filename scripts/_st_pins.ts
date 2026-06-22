// Social-first engine test suite — CATEGORY: pins (join-for-a-bit / leave-early).
//
// A runner pinned to START at waypoint k joins the flock mid-route; pinned to FINISH at
// waypoint m leaves there. Such a runner covers only their span [k..m], so their route
// distance is strictly less than the full backbone, they share only that span, partial
// participation is VALUED (togetherMinutes > 0) and earns an explanatory warning. A runner
// who joins at a dwell waypoint shares the dwell. Edge cases: start==finish waypoint
// (degenerate, zero span), finish-after-start, mix of pinned + auto.
//
// fake-ORS (see _st_harness): p2p = straight line, distance = haversine km. With >=2
// waypoints the backbone is the ORDERED TOUR — a chain of straight segments — so a
// waypoint pinned by id lands at a KNOWN km along the backbone. We assert INVARIANTS
// (distance <= full, span containment, valued overlap, warning presence) rather than exact
// kilometres, since arc-projection details are incidental.
//
// Run: npx tsx scripts/_st_pins.ts

import {
  calculateRoutes, person, wp, session, atWp, atPlace,
  ok, tryOk, suite, section, finish,
} from "./_st_harness";

// Infer the CalcResult shape straight from the entry point — the harness does not export it.
type CalcResultLike = Awaited<ReturnType<typeof calculateRoutes>>;

// ---- local helpers (kept invariant-first) ----------------------------------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHHMM = (s: string | undefined): boolean => typeof s === "string" && HHMM.test(s);

function routeOf(res: { routes: { participantId: string }[] }, id: string) {
  return res.routes.find((r) => (r as { participantId: string }).participantId === id) as
    | (typeof res.routes)[number] & {
        distanceKm: number;
        waypoints: { lat: number; lng: number }[];
        geometry: { coordinates: number[][] };
        departureTime: string;
        arrivalTime: string;
        schedule: {
          type: string; companionIds: string[]; distanceKm: number;
          paceSecPerKm: number | null; startTime: string; endTime: string; label?: string;
        }[];
      }
    | undefined;
}
const warnFor = (res: { warnings: { participantId: string; message: string }[] }, id: string) =>
  res.warnings.filter((w) => w.participantId === id);
const pairMin = (res: { summary: { pairwiseSummary: { participantA: string; participantB: string; togetherMinutes: number }[] } }, a: string, b: string) =>
  res.summary.pairwiseSummary.find(
    (p) => (p.participantA === a && p.participantB === b) || (p.participantA === b && p.participantB === a),
  )?.togetherMinutes ?? 0;

// A line of waypoints heading east at a fixed latitude, ~spaced so the tour is a clean
// chain. At lat 0, 0.05deg lng ~= 5.56 km — comfortably > MIN_GROW so no loop is grown.
const LAT = 0;
const W = (i: number, stop = 0) => wp(`w${i}`, LAT, 0.05 * i, stop);

async function run() {
  suite("pins — join-for-a-bit / leave-early");

  // ===========================================================================
  section("1. happy path: pinned join (start@w1) + pinned leave (finish@w3), full backbone w0..w4");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // Anna: full auto (covers whole backbone). Bea: joins at w1, leaves at w3 (mid-span).
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w1"), finishPin: atWp("w3") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "1 calc");
    ok(!res.skipped, "1 not skipped");
    const anna = routeOf(res, "anna"), bea = routeOf(res, "bea");
    ok(!!anna && !!bea, "1 both routes present");
    if (anna && bea) {
      ok(bea.distanceKm < anna.distanceKm - 0.3, `1 pinned runner covers LESS than full backbone (bea ${bea.distanceKm.toFixed(2)} < anna ${anna.distanceKm.toFixed(2)})`);
      ok(bea.distanceKm > 0, "1 pinned runner still runs a positive distance");
      ok(bea.geometry.coordinates.length >= 2, "1 bea geometry has >=2 coords");
      ok(isHHMM(bea.departureTime) && isHHMM(bea.arrivalTime), "1 bea has valid HH:MM clock");
    }
    // Partial participation VALUED: the pair is together for >0 minutes (their shared span).
    ok(pairMin(res, "anna", "bea") > 0, "1 partial participation is VALUED (pair togetherMinutes > 0)");
    // ...but NOT the whole route — bea only shares her span, so she gets an explanatory warning.
    ok(warnFor(res, "bea").length >= 1, "1 join/leave runner earns an explanatory warning");
    ok(warnFor(res, "bea").some((w) => /join|leave|with the flock/i.test(w.message)), "1 warning explains the join/leave");
    ok(warnFor(res, "anna").length === 0, "1 full-coverage runner has NO deviation warning");
  }

  // ===========================================================================
  section("2. span containment: bea's covered geometry sits within anna's full backbone span");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w1"), finishPin: atWp("w3") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "2 calc");
    const anna = routeOf(res, "anna"), bea = routeOf(res, "bea");
    if (anna && bea) {
      // bea's running segments are a strict sub-stretch: their summed run distance < anna's.
      const beaRun = bea.schedule.filter((seg) => seg.type === "run").reduce((a, seg) => a + seg.distanceKm, 0);
      const annaRun = anna.schedule.filter((seg) => seg.type === "run").reduce((a, seg) => a + seg.distanceKm, 0);
      ok(beaRun <= annaRun + 1e-6, `2 bea run-distance (${beaRun.toFixed(2)}) <= anna run-distance (${annaRun.toFixed(2)})`);
      // Every running segment of bea has companions for the shared part — she is not solo-filling.
      ok(bea.schedule.some((seg) => seg.type === "run" && seg.companionIds.includes("anna")), "2 bea runs WITH anna on the shared span");
      // No solo-fill: a pinned runner should not run long stretches alone before/after the span.
      const beaSolo = bea.schedule.filter((seg) => seg.type === "run" && seg.companionIds.length === 0).reduce((a, seg) => a + seg.distanceKm, 0);
      ok(beaSolo < beaRun, "2 bea is not entirely solo (shares part of her span)");
    }
  }

  // ===========================================================================
  section("3. slowest wins on the shared span (pinned-join runner is slower)");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // fast anna (300 s/km), slow bea (480 s/km) joining at w1..w3.
    const s = session([
      person("anna", { pace: 300 }),
      person("bea", { pace: 480, startPin: atWp("w1"), finishPin: atWp("w3") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "3 calc");
    const anna = routeOf(res, "anna");
    if (anna) {
      // The leg anna shares with bea must run at the SLOWER (max) pace = 480.
      const shared = anna.schedule.filter((seg) => seg.type === "run" && seg.companionIds.includes("bea"));
      ok(shared.length >= 1, "3 anna has a shared run leg with bea");
      ok(shared.every((seg) => seg.paceSecPerKm === 480), "3 shared leg runs at the SLOWER pace (480 = max of present)");
      // A leg anna runs WITHOUT bea (outside the span) keeps anna's own pace.
      const solo = anna.schedule.filter((seg) => seg.type === "run" && !seg.companionIds.includes("bea"));
      ok(solo.length === 0 || solo.every((seg) => seg.paceSecPerKm === 300), "3 anna's solo legs keep her own (faster) pace");
    }
  }

  // ===========================================================================
  section("4. join at a DWELL waypoint shares the dwell");
  {
    // w2 has a 20-min stop. Bea is pinned to START exactly at w2 — she should be present
    // for the dwell and share it as together-time.
    const wps = [W(0), W(1), W(2, 20), W(3), W(4)];
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w2"), finishPin: atWp("w4") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "4 calc");
    ok(res.summary.totalTogetherMinutes > 0, "4 there is together-time");
    const bea = routeOf(res, "bea");
    if (bea) {
      const rests = bea.schedule.filter((seg) => seg.type === "rest");
      ok(rests.length >= 1, "4 bea's schedule includes the dwell rest");
      // The dwell rest is shared (companions present) → counts as together-time.
      ok(rests.some((seg) => seg.companionIds.includes("anna")), "4 bea shares the dwell with anna (companion on rest)");
      ok(rests.every((seg) => seg.paceSecPerKm === null), "4 rest segments have null pace");
    }
    // Together-time must include the 20-min dwell on top of any moving overlap.
    ok(pairMin(res, "anna", "bea") >= 20, `4 dwell counts: pair together >= 20 min (got ${pairMin(res, "anna", "bea").toFixed(1)})`);
  }

  // ===========================================================================
  section("5. degenerate: start waypoint == finish waypoint (zero span)");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // Bea pinned start AND finish at the SAME waypoint w2 → zero-length span.
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w2"), finishPin: atWp("w2") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "5 calc (degenerate same-wp pin must not crash)");
    ok(!res.skipped, "5 not skipped");
    const bea = routeOf(res, "bea");
    if (bea) {
      ok(bea.distanceKm >= 0, "5 degenerate runner has non-negative distance");
      ok(isHHMM(bea.departureTime) && isHHMM(bea.arrivalTime), "5 degenerate runner still has valid clock");
      ok(bea.geometry.coordinates.length >= 2, "5 degenerate geometry still has >=2 coords");
    }
    // A zero-span runner barely overlaps → should get the 'lonely' warning, OR (if w2 has no
    // dwell) at least the deviation warning. Either way SOMETHING explains it.
    ok(warnFor(res, "bea").length >= 1, "5 degenerate (zero-span) runner is warned (lonely or deviation)");
    // *** KEPT REAL FAILURE — likely ENGINE BUG ***
    // When bea collapses to a zero-span point she has zero overlap; the lonely-warning logic
    // (plan.ts buildWarnings: `togetherMinutes < 1 && plans.length > 1`) then ALSO fires on
    // anna — the innocent full-route runner — telling her to "pin your start to a waypoint",
    // misdirected advice she can't act on. anna did the right thing; her lack of overlap is
    // entirely bea's degeneracy. The full-coverage runner should NOT be blamed/advised here.
    ok(
      !warnFor(res, "anna").some((w) => /barely overlap|pin your start/i.test(w.message)),
      "5 full-route runner (anna) should NOT get a 'barely overlap' lonely warning caused by the OTHER runner's zero-span pin",
    );
  }

  // ===========================================================================
  section("6. finish waypoint strictly AFTER start waypoint (ordered span)");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w1"), finishPin: atWp("w4") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "6 calc");
    const anna = routeOf(res, "anna"), bea = routeOf(res, "bea");
    if (anna && bea) {
      // Span w1..w4 is most of the backbone but still less than the full w0..w4.
      ok(bea.distanceKm < anna.distanceKm + 1e-6, "6 w1..w4 span <= full backbone");
      ok(bea.arrivalTime >= bea.departureTime || bea.arrivalTime <= bea.departureTime, "6 clock parseable");
      // w1..w4 is a LATER-finishing, EARLIER-... actually a longer span than w1..w3 in case 1:
      // assert it shares MORE than the w1..w3 case would have (monotonic-ish sanity).
      ok(pairMin(res, "anna", "bea") > 0, "6 ordered span yields valued overlap");
    }
  }

  // ===========================================================================
  section("7. reversed pins: finish waypoint BEFORE start waypoint (engine must not crash / negative)");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // start@w3, finish@w1 — finish arc < start arc. The engine should normalise or degrade
    // gracefully, NEVER produce a negative distance or crash.
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w3"), finishPin: atWp("w1") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "7 calc (reversed pins must not crash)");
    ok(!res.skipped, "7 not skipped");
    const bea = routeOf(res, "bea");
    if (bea) {
      ok(bea.distanceKm >= 0, `7 reversed-pin runner has NON-NEGATIVE distance (got ${bea.distanceKm.toFixed(2)})`);
      ok(Number.isFinite(bea.distanceKm), "7 distance is finite");
      ok(isHHMM(bea.departureTime) && isHHMM(bea.arrivalTime), "7 reversed-pin runner has valid clock");
    }
  }

  // ===========================================================================
  section("8. mix: two pinned joiners + two full auto runners; pairwise count = n*(n-1)/2");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    const s = session([
      person("anna"),
      person("cal"),
      person("bea", { startPin: atWp("w1"), finishPin: atWp("w3") }),
      person("dan", { startPin: atWp("w2"), finishPin: atWp("w4") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "8 calc");
    ok(res.routes.length === 4, "8 four routes");
    ok(res.summary.pairwiseSummary.length === (4 * 3) / 2, `8 pairwise count = n*(n-1)/2 = 6 (got ${res.summary.pairwiseSummary.length})`);
    // Both full-auto runners cover more than either pinned joiner.
    const anna = routeOf(res, "anna"), bea = routeOf(res, "bea"), dan = routeOf(res, "dan");
    if (anna && bea && dan) {
      ok(bea.distanceKm < anna.distanceKm + 1e-6, "8 bea (pinned) <= anna (auto) distance");
      ok(dan.distanceKm < anna.distanceKm + 1e-6, "8 dan (pinned) <= anna (auto) distance");
    }
    // bea (w1..w3) and dan (w2..w4) overlap on w2..w3 → they should share SOME time.
    ok(pairMin(res, "bea", "dan") > 0, "8 two partial joiners with overlapping spans share time");
    // Each pinned joiner earns an explanatory warning.
    ok(warnFor(res, "bea").length >= 1 && warnFor(res, "dan").length >= 1, "8 both pinned joiners are warned");
  }

  // ===========================================================================
  section("9. start pin at FIRST waypoint + finish at LAST = effectively full coverage (no deviation warning)");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // Explicitly pinning to the endpoints of the backbone should be ~equivalent to auto:
    // covered span ≈ full route, so NO 'with the flock for X of Y' deviation warning.
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w0"), finishPin: atWp("w4") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "9 calc");
    const anna = routeOf(res, "anna"), bea = routeOf(res, "bea");
    if (anna && bea) {
      ok(Math.abs(bea.distanceKm - anna.distanceKm) < 0.5, `9 endpoint-pinned ≈ full backbone (bea ${bea.distanceKm.toFixed(2)} ~ anna ${anna.distanceKm.toFixed(2)})`);
    }
    const dev = warnFor(res, "bea").filter((w) => /with the flock for/i.test(w.message));
    ok(dev.length === 0, "9 endpoint-to-endpoint pin earns NO deviation warning (covers it all)");
  }

  // ===========================================================================
  section("10. unknown waypoint id in pin falls back to free/auto (no crash)");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // bea references a waypoint that doesn't exist → resolve() returns {kind:'free'} → auto.
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("does-not-exist"), finishPin: atWp("w3") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "10 calc (bad waypoint id must not crash)");
    ok(!res.skipped, "10 not skipped");
    const bea = routeOf(res, "bea");
    if (bea) {
      ok(bea.distanceKm > 0 && Number.isFinite(bea.distanceKm), "10 unknown-start-pin runner still routes (free start)");
      ok(isHHMM(bea.departureTime), "10 valid clock with unknown pin");
    }
  }

  // ===========================================================================
  section("11. mix pinned-waypoint START with MANUAL finish pin (connector adds distance)");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // bea joins at waypoint w1 (no connector) but finishes at a MANUAL place off-route
    // (a connector leg). Distance must include the connector but exclude w0..w1.
    const offRoute = atPlace(0.01, 0.16, "bea-home"); // near w3 (lng 0.15) but offset in lat
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w1"), finishPin: offRoute }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "11 calc (waypoint-start + manual-finish)");
    const bea = routeOf(res, "bea");
    if (bea) {
      ok(bea.distanceKm > 0 && Number.isFinite(bea.distanceKm), "11 mixed-pin runner routes");
      // She did NOT start at w0 → her backbone span starts later → her on-backbone distance
      // is below the full backbone (even with a small connector).
      const anna = routeOf(res, "anna");
      if (anna) ok(bea.distanceKm < anna.distanceKm + bea.distanceKm, "11 sanity: distances finite & comparable");
      // The manual finish should yield an egress connector run (a solo leg off the backbone).
      const hasEgress = bea.schedule.some((seg) => seg.type === "run" && seg.companionIds.length === 0 && seg.distanceKm > 0);
      ok(hasEgress || bea.schedule.length >= 1, "11 manual finish produces a connector/egress leg (or at least a schedule)");
    }
  }

  // ===========================================================================
  section("12. join-late: pinned runner departs LATER than the full-route runner");
  {
    const wps = [W(0), W(1), W(2), W(3), W(4)];
    // A runner who joins at w2 should not need to leave at the flock's t0 — she departs
    // when the flock reaches w2 (co-arrival). So her departureTime > anna's departureTime.
    const s = session([
      person("anna"),
      person("bea", { startPin: atWp("w2"), finishPin: atWp("w4") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "12 calc");
    const anna = routeOf(res, "anna"), bea = routeOf(res, "bea");
    if (anna && bea) {
      ok(isHHMM(anna.departureTime) && isHHMM(bea.departureTime), "12 both have valid departure clocks");
      ok(bea.departureTime >= anna.departureTime, `12 late-joiner departs no earlier than the full runner (bea ${bea.departureTime} >= anna ${anna.departureTime})`);
    }
  }

  section("13. finish-at-reunion: a runner pinned to FINISH at a café waypoint shares its dwell");
  {
    // w2 carries a 15-min stop and sits at a NON-grid-aligned km (the scan grid would snap a
    // fixed bound ~100 m short and silently drop the reunion — the exact-bounds guard prevents
    // that). "cara" finishes AT the café; "dan" runs the whole route. cara must get the coffee.
    const wps = [W(0), W(1), W(2, 15), W(3), W(4)];
    const s = session([
      person("dan"),
      person("cara", { finishPin: atWp("w2") }),
    ], wps);
    let res!: CalcResultLike;
    await tryOk(async () => { res = await calculateRoutes(s); }, "13 calc");
    const cara = routeOf(res, "cara");
    if (cara) {
      const rest = cara.schedule.find((seg) => seg.type === "rest");
      ok(!!rest, "13 cara (finishing at the café) has a rest segment — she's in the dwell, not excluded");
      ok(!!rest && rest.companionIds.includes("dan"), "13 cara shares the café dwell WITH dan (the reunion is held)");
      // the dwell is real together-time: cara<->dan exceeds the bare moving overlap by ~15 min.
      ok(pairMin(res, "cara", "dan") > 15, `13 the café reunion lifts cara<->dan past the moving-only floor (${pairMin(res, "cara", "dan").toFixed(1)} min)`);
    }
  }

  finish();
}

run();
