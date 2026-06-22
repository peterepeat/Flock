// Social-first engine test suite — CATEGORY: distance caps (maxDistanceKm).
//
// Behaviour under test (from the spec):
//   - A capped runner's covered arc is bounded by the cap: route.distanceKm <= cap
//     (auto pins have no connector, so distanceKm == covered arc).
//   - cap >= full route => the runner covers the WHOLE route (no peel).
//   - A capped runner is PLACED to maximise overlap — banks together-time, and tends
//     to sit on the dense stretch / the café (dwell counts as together-time).
//   - A runner not covering the whole route gets an explanatory warning.
//   - A near-zero-overlap runner gets a "barely overlap" lonely warning.
//   - SLOWEST WINS: a shared run leg's pace == max of present runners' paces.
//
// Invariant-first: distanceKm <= cap, arrival <= deadline, pace == max present,
// pairwise count == n*(n-1)/2, valid HH:MM, no throw. Exact numbers only where the
// fake-ORS makes them exactly computable (haversine p2p, no road factor).
//
// Run: npx tsx scripts/_st_caps.ts

import {
  calculateRoutes,
  person,
  wp,
  session,
  auto,
  atWp,
  ok,
  tryOk,
  suite,
  section,
  finish,
  atPlace,
  type FlockSession,
} from "./_st_harness";
import type { FlockCalcResult as CalcResult } from "../src/lib/flock/project";

const EPS = 0.06; // tolerance for round2 on distanceKm / km comparisons
const HHMM = /^\d{2}:\d{2}$/;

const routeOf = (r: CalcResult, id: string) => r.routes.find((x) => x.participantId === id);
const warnOf = (r: CalcResult, id: string) => r.warnings.find((w) => w.participantId === id);
const totalRouteKm = (r: CalcResult): number =>
  Math.max(0, ...r.routes.map((x) => x.distanceKm));

// A geography with a clear linear corridor and a "café" waypoint with a long dwell
// near the far end, so a placement that maximises overlap should cover the café.
// Waypoints are spread along increasing lat so the tour length is well > any small cap.
const A: [number, number] = [-37.80, 144.96];
const B: [number, number] = [-37.84, 144.96];
const CAFE: [number, number] = [-37.88, 144.96]; // ~8.9 km from A
const D: [number, number] = [-37.92, 144.96];

function corridor(stopMin = 0) {
  return [
    wp("a", A[0], A[1]),
    wp("b", B[0], B[1]),
    wp("cafe", CAFE[0], CAFE[1], stopMin),
    wp("d", D[0], D[1]),
  ];
}

async function run(): Promise<void> {
  suite("caps — maxDistanceKm");

  // ---------------------------------------------------------------------------
  section("cap >= route — full route, no peel");
  {
    let res!: CalcResult;
    const s: FlockSession = session(
      [person("full"), person("mate")],
      corridor(),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "cap>=route compute");
    if (res && !res.skipped) {
      const L = totalRouteKm(res);
      // Give 'full' a cap comfortably above the route length: should not peel.
      let res2!: CalcResult;
      const s2 = session([person("full", { maxDistanceKm: L + 5 }), person("mate")], corridor());
      await tryOk(async () => {
        res2 = await calculateRoutes(s2);
      }, "cap>=route (explicit) compute");
      const full = routeOf(res2, "full");
      ok(!!full, "full runner has a route");
      if (full) {
        ok(full.distanceKm <= L + 5 + EPS, `cap>=route: distanceKm ${full.distanceKm} <= cap ${L + 5}`);
        ok(full.distanceKm >= L - 0.5, `cap>=route: covers ~whole route (${full.distanceKm} ~>= ${L.toFixed(2)})`);
        // No "stay within your distance" warning when the cap doesn't bind.
        const w = warnOf(res2, "full");
        ok(!w || !/within your distance/.test(w.message), "cap>=route: no distance-peel warning");
      }
    }
  }

  // ---------------------------------------------------------------------------
  section("cap < route — runner peels, distanceKm <= cap, banks together-time");
  {
    let res!: CalcResult;
    const cap = 4; // well under the ~13 km corridor tour
    const s = session(
      [person("uncapped"), person("capped", { maxDistanceKm: cap })],
      corridor(),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "cap<route compute");
    if (res && !res.skipped) {
      const L = totalRouteKm(res);
      const capped = routeOf(res, "capped");
      ok(!!capped, "capped runner has a route");
      if (capped) {
        ok(L > cap + 1, `route (${L.toFixed(2)} km) is longer than the cap (${cap} km) — peel expected`);
        ok(capped.distanceKm <= cap + EPS, `INVARIANT: distanceKm ${capped.distanceKm} <= cap ${cap}`);
        ok(capped.distanceKm > 0, "capped runner still covers a positive arc");
        // Banks together-time: appears in a pairwise summary with > 0 minutes.
        const pair = res.summary.pairwiseSummary.find(
          (p) => p.participantA === "capped" || p.participantB === "capped",
        );
        ok(!!pair && pair.togetherMinutes > 0, `capped banks together-time (${pair?.togetherMinutes} min)`);
        // Explanatory peel warning.
        const w = warnOf(res, "capped");
        ok(!!w, "capped runner gets a warning");
        ok(!!w && /within your distance/.test(w.message), `peel warning explains the cap: "${w?.message}"`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  section("several different caps — each runner's distanceKm <= its own cap");
  {
    let res!: CalcResult;
    const caps: Record<string, number> = { p2: 2, p5: 5, p8: 8 };
    const s = session(
      [
        person("uncapped"),
        person("p2", { maxDistanceKm: 2 }),
        person("p5", { maxDistanceKm: 5 }),
        person("p8", { maxDistanceKm: 8 }),
      ],
      corridor(),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "several-caps compute");
    if (res && !res.skipped) {
      for (const [id, cap] of Object.entries(caps)) {
        const r = routeOf(res, id);
        ok(!!r, `${id} has a route`);
        if (r) ok(r.distanceKm <= cap + EPS, `INVARIANT: ${id} distanceKm ${r.distanceKm} <= cap ${cap}`);
      }
      // Monotone-ish: a larger cap covers at least as much arc as a smaller one.
      const d2 = routeOf(res, "p2")?.distanceKm ?? 0;
      const d8 = routeOf(res, "p8")?.distanceKm ?? 0;
      ok(d8 >= d2 - EPS, `bigger cap covers >= smaller cap arc (p8 ${d8} >= p2 ${d2})`);
      // n=4 participants => 6 pairwise rows.
      ok(res.summary.pairwiseSummary.length === 6, `pairwise count == n*(n-1)/2 == 6 (got ${res.summary.pairwiseSummary.length})`);
    }
  }

  // ---------------------------------------------------------------------------
  section("cap places runner ACROSS the café — dwell banked as together-time");
  {
    let res!: CalcResult;
    // A long dwell at the café makes the café the densest together-time. A capped
    // runner maximising overlap should cover the café arc and share the rest.
    const cap = 4;
    const s = session(
      [person("anchor"), person("capped", { maxDistanceKm: cap })],
      corridor(20), // 20-min café dwell
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "cafe-cap compute");
    if (res && !res.skipped) {
      const capped = routeOf(res, "capped");
      ok(!!capped, "capped runner has a route");
      if (capped) {
        ok(capped.distanceKm <= cap + EPS, `INVARIANT: distanceKm ${capped.distanceKm} <= cap ${cap}`);
        // The café dwell should appear as a rest segment with a companion for the
        // capped runner (it banked the dwell as together-time).
        const restWithCompany = capped.schedule.some(
          (seg) => seg.type === "rest" && seg.companionIds.length >= 1,
        );
        ok(restWithCompany, "capped runner shares the café dwell (rest leg w/ companions)");
        ok(res.summary.totalTogetherMinutes > 0, `together-time banked (${res.summary.totalTogetherMinutes} min)`);
        // Dwell counts: with a 20-min café stop shared, together-time should exceed
        // a bare moving overlap floor.
        ok(res.summary.totalTogetherMinutes >= 1, "dwell counts toward together-time");
      }
    }
  }

  // ---------------------------------------------------------------------------
  section("tiny (near-zero) cap — lonely / short warning, no crash");
  {
    let res!: CalcResult;
    const cap = 0.3; // far smaller than any meaningful overlap arc
    const s = session(
      [person("group1"), person("group2"), person("tiny", { maxDistanceKm: cap })],
      corridor(),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "tiny-cap compute");
    if (res && !res.skipped) {
      const tiny = routeOf(res, "tiny");
      ok(!!tiny, "tiny-cap runner has a route");
      if (tiny) {
        ok(tiny.distanceKm <= cap + EPS, `INVARIANT: tiny distanceKm ${tiny.distanceKm} <= cap ${cap}`);
      }
      // A tiny cap means near-zero overlap => a warning of some kind (lonely or peel).
      const w = warnOf(res, "tiny");
      ok(!!w, `tiny-cap runner gets an explanatory warning: "${w?.message}"`);
    }
  }

  // ---------------------------------------------------------------------------
  section("SLOWEST WINS on a shared leg under a cap");
  {
    let res!: CalcResult;
    // Fast uncapped + slow capped sharing the café arc: the shared run leg's pace
    // must equal the slower (larger sec/km) of the two present.
    const fast = 300; // sec/km
    const slow = 480; // sec/km
    const s = session(
      [person("fast", { pace: fast }), person("slow", { pace: slow, maxDistanceKm: 5 })],
      corridor(),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "slowest-wins compute");
    if (res && !res.skipped) {
      const fastR = routeOf(res, "fast");
      ok(!!fastR, "fast runner has a route");
      if (fastR) {
        const shared = fastR.schedule.filter(
          (seg) => seg.type === "run" && seg.companionIds.includes("slow"),
        );
        ok(shared.length > 0, "fast runner has a shared run leg with the slow capped runner");
        for (const seg of shared) {
          ok(
            seg.paceSecPerKm === slow,
            `SLOWEST WINS: shared leg pace ${seg.paceSecPerKm} == slow ${slow}`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  section("cap + waypoint pin — capped runner joining AT a waypoint stays <= cap");
  {
    let res!: CalcResult;
    const cap = 4;
    const s = session(
      [
        person("anchor"),
        person("joiner", { startPin: atWp("b"), finishPin: auto, maxDistanceKm: cap }),
      ],
      corridor(),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "cap+wp-pin compute");
    if (res && !res.skipped) {
      const j = routeOf(res, "joiner");
      ok(!!j, "joiner has a route");
      if (j) {
        ok(j.distanceKm <= cap + EPS, `INVARIANT: joiner distanceKm ${j.distanceKm} <= cap ${cap}`);
        // Valid HH:MM clock fields.
        ok(HHMM.test(j.departureTime) && HHMM.test(j.arrivalTime), `valid HH:MM (${j.departureTime}→${j.arrivalTime})`);
        ok(j.geometry.coordinates.length >= 2, "joiner geometry is a real line (>=2 coords)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  section("cap == 0 — degenerate; must not crash, distanceKm ~0");
  {
    let res!: CalcResult;
    const s = session(
      [person("base"), person("zero", { maxDistanceKm: 0 })],
      corridor(),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "cap==0 compute (must not throw)");
    if (res && !res.skipped) {
      const z = routeOf(res, "zero");
      // Engine may drop a zero-cap runner or keep a degenerate route; either way no crash.
      if (z) {
        ok(z.distanceKm <= EPS, `cap==0: distanceKm ${z.distanceKm} ~ 0`);
        ok(z.geometry.coordinates.length >= 1, "cap==0: geometry present (not corrupt)");
      } else {
        ok(true, "cap==0: runner dropped (acceptable)");
      }
    } else if (res) {
      ok(true, "cap==0: session skipped (acceptable degenerate)");
    }
  }

  // ---------------------------------------------------------------------------
  section("cap on a no-waypoint flock (default 10 km loop, anchored by a pin)");
  {
    // No waypoints => default loop. The engine needs a geographic anchor (it skips an
    // all-auto, no-waypoint flock — line index.ts:40-41), so one runner pins a start.
    let res!: CalcResult;
    const cap = 4;
    const s = session(
      [
        person("loopA", { startPin: atPlace(A[0], A[1]) }),
        person("loopB", { maxDistanceKm: cap }),
      ],
      [],
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "cap+noWp compute");
    ok(!!res && !res.skipped, "anchored no-waypoint flock is NOT skipped (default loop)");
    if (res && !res.skipped) {
      const b = routeOf(res, "loopB");
      ok(!!b, "capped runner on default loop has a route");
      if (b) {
        ok(b.distanceKm <= cap + EPS, `INVARIANT: distanceKm ${b.distanceKm} <= cap ${cap}`);
        ok(b.geometry.coordinates.length >= 2, "loop geometry is a real line");
      }
    }
  }

  // ---------------------------------------------------------------------------
  section("EDGE: all-auto, no-waypoint flock — documents skip behaviour");
  {
    // Spec: intendedDistance null + <=1 waypoint => default 10 km. But with NO waypoint
    // and ALL-auto pins there is no geographic anchor, so the engine returns skipped.
    // This asserts the ACTUAL (defensible) behaviour so a future change is noticed.
    let res!: CalcResult;
    const s = session([person("a"), person("b", { maxDistanceKm: 4 })], []);
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "all-auto-noWp compute (must not throw)");
    ok(!!res, "all-auto no-waypoint returns a result (no throw)");
    if (res) {
      ok(res.skipped === true, "all-auto no-waypoint flock is skipped (no routable anchor)");
      ok(res.routes.length === 0, "skipped result has no routes");
    }
  }

  // ---------------------------------------------------------------------------
  section("two equal caps both bind — each <= cap, both bank together-time");
  {
    let res!: CalcResult;
    const cap = 5;
    const s = session(
      [
        person("anchor"),
        person("c1", { maxDistanceKm: cap }),
        person("c2", { maxDistanceKm: cap }),
      ],
      corridor(15),
    );
    await tryOk(async () => {
      res = await calculateRoutes(s);
    }, "two-equal-caps compute");
    if (res && !res.skipped) {
      for (const id of ["c1", "c2"]) {
        const r = routeOf(res, id);
        ok(!!r, `${id} has a route`);
        if (r) ok(r.distanceKm <= cap + EPS, `INVARIANT: ${id} distanceKm ${r.distanceKm} <= cap ${cap}`);
      }
      // Two capped runners + anchor should converge on the same dense arc and overlap.
      const pair = res.summary.pairwiseSummary.find(
        (p) =>
          (p.participantA === "c1" && p.participantB === "c2") ||
          (p.participantA === "c2" && p.participantB === "c1"),
      );
      ok(!!pair, "c1/c2 pair present in summary");
      ok(!!pair && pair.togetherMinutes > 0, `two equal-capped runners overlap (${pair?.togetherMinutes} min)`);
    }
  }

  finish();
}

run();
