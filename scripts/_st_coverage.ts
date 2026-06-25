// Coverage invariant — the guard against the recurring "a runner who COULD run the whole route
// doesn't" defect. The principle: a runner whose only constraint is AT MOST ONE manual fixed end
// (no distance cap, no time limit) runs the WHOLE spine. We measure it by full-overlap together-time:
// if the pinned runner and a free companion both cover [0,L], their together-time equals the spine's
// own duration. A truncated runner overlaps LESS, so the assertion fails — exactly the bug class.
// Sweeps the pinned end, the pin offset, the second runner, and the waypoint count (the anchored
// regimes, 0/1 waypoint). Deterministic fake-ORS.
//
//   run: npx tsx scripts/_st_coverage.ts

import { calculateRoutes, person, wp, atPlace, atWp, session, suite, section, ok, tryOk, finish, lineKm, type FlockCalcResult, type Participant } from "./_st_harness";

const B = { lat: -37.81, lng: 144.96 };
const PACE_MIN_PER_KM = 6; // person() default 360 s/km
const L = (r: FlockCalcResult) => (r.flockRoute ? lineKm(r.flockRoute.coordinates) : 0);
// Both runners cover [0,L] ⇒ together (wall) ≈ spine duration. Truncation drops it.
const fullyOverlaps = (r: FlockCalcResult) => {
  const expect = L(r) * PACE_MIN_PER_KM;
  return { ok: r.summary.totalTogetherMinutes >= 0.9 * expect, got: r.summary.totalTogetherMinutes, expect };
};

async function main() {
  suite("coverage invariant — unconstrained runners run the whole route");

  // ── A flock of [free companion, P] where P has exactly one MANUAL fixed end, no cap, no time.
  //    P must run the full spine (⇒ full-overlap together-time), at every offset, with/without a
  //    landmark. This is the general form of the Collin defect.
  section("one manual fixed end + a free companion → full coverage");
  const offsets: Array<[number, number]> = [[0, 0], [0.01, 0.0], [0.0, 0.03], [0.02, 0.05], [-0.015, 0.04]];
  for (const end of ["start", "finish"] as const) {
    // 0 waypoints (loop), 1 (loop through a landmark), AND 2 (the organizer's one-way corridor — the
    // untested regime where a pin used to PROJECT and skip the leading/trailing waypoint, the kwhw9x bug).
    for (const wps of [[], [wp("w", B.lat + 0.02, B.lng + 0.02)], [wp("w1", B.lat + 0.02, B.lng + 0.02), wp("w2", B.lat + 0.05, B.lng + 0.04)]] as const) {
      for (const [dLat, dLng] of offsets) {
        const pin = atPlace(B.lat + dLat, B.lng + dLng);
        const P: Participant = person("p", end === "start" ? { startPin: pin } : { finishPin: pin });
        const sig = `${end}-pin off(${dLat},${dLng}) wp=${wps.length}`;
        await tryOk(async () => {
          const r = await calculateRoutes(session([person("free"), P], [...wps]));
          if (r.unroutable) { ok(false, `${sig}: unexpectedly unroutable`); return; }
          const f = fullyOverlaps(r);
          ok(f.ok, `${sig}: P covers the whole spine (together ${f.got.toFixed(1)} ≥ 0.9×${f.expect.toFixed(1)} min)`);
        }, sig);
      }
    }
  }

  // ── Two runners with DIFFERENT manual starts (free finishes) — both must run the full loop and
  //    meet for the whole thing (the multi-start generalisation: neither is truncated to its pin).
  section("two different manual starts → both cover the whole loop");
  for (const wps of [[], [wp("w", B.lat + 0.02, B.lng + 0.02)]] as const) {
    await tryOk(async () => {
      const r = await calculateRoutes(session([
        person("p", { startPin: atPlace(B.lat, B.lng) }),
        person("c", { startPin: atPlace(B.lat + 0.012, B.lng + 0.045) }),
      ], [...wps]));
      const f = fullyOverlaps(r);
      ok(f.ok, `wp=${wps.length}: both cover the whole loop (together ${f.got.toFixed(1)} ≥ 0.9×${f.expect.toFixed(1)} min)`);
    }, `two-starts wp=${wps.length}`);
  }

  // ── Collin's exact reported shape: free runner + manual-start/free-finish runner + one landmark.
  section("the reported Collin shape: free + (manual start, free finish) + a landmark");
  await tryOk(async () => {
    const r = await calculateRoutes(session([
      person("peter"),
      person("collin", { startPin: atPlace(-37.8142454, 144.9631732) }),
    ], [wp("bakery", -37.8025203, 145.0035085)]));
    const spine = L(r);
    const collin = r.routes.find((x) => x.participantId === "collin")?.distanceKm ?? 0;
    const peter = r.routes.find((x) => x.participantId === "peter")?.distanceKm ?? 0;
    ok(collin >= 0.9 * spine, `Collin runs the whole route (${collin.toFixed(2)} ≥ 0.9×${spine.toFixed(2)} km)`);
    ok(Math.abs(collin - peter) < 0.5, `Collin and Peter run ~the same distance (${collin.toFixed(2)} vs ${peter.toFixed(2)} km)`);
  }, "collin-exact");

  // ── kwhw9x's exact reported shape: a TWO-waypoint organizer corridor (Convent → East Richmond) with
  //    two manual-start / free-finish runners whose homes sit BESIDE / BEFORE the first waypoint. Under
  //    the old projection model both joined the corridor PAST the Convent, so NOBODY traversed the first
  //    waypoint (its ETA collapsed to 00:00) and they barely overlapped. With endpoint-anchoring both
  //    meet at the Convent (km 0) and run the whole corridor together — every waypoint a true passage.
  section("two-waypoint corridor: every waypoint is traversed (the kwhw9x defect)");
  await tryOk(async () => {
    const r = await calculateRoutes(session([
      person("peter", { startPin: atPlace(-37.7706783, 144.9924143) }),  // north of the Convent
      person("collin", { startPin: atPlace(-37.8142454, 144.9631732) }), // west of the corridor
    ], [wp("convent", -37.8025203, 145.0035085), wp("richmond", -37.8263517, 144.9966361)]));
    const f = fullyOverlaps(r);
    ok(f.ok, `both run the whole corridor together (together ${f.got.toFixed(1)} ≥ 0.9×${f.expect.toFixed(1)} min)`);
    // The FIRST waypoint is genuinely traversed — its ETA is a real flock-clock time, not the 00:00 that
    // arrivalAt() returns when no block covers km 0 (the tell-tale that the corridor's head was skipped).
    const conventEta = r.waypointEtas?.["convent"];
    ok(conventEta != null && conventEta !== "00:00", `the Convent (first waypoint) is traversed (ETA ${conventEta})`);
  }, "kwhw9x-corridor");

  // ── A runner who pins their FINISH to the sole waypoint (which becomes the loop's anchor) must
  //    still run the whole loop and finish there — not collapse to km 0 = 0 coverage. (Audit edge.)
  section("a waypoint-finish at the loop anchor still covers the whole loop");
  await tryOk(async () => {
    const r = await calculateRoutes(session([person("free"), person("p", { finishPin: atWp("w") })], [wp("w", B.lat + 0.02, B.lng + 0.03)]));
    const f = fullyOverlaps(r);
    ok(f.ok, `waypoint-finish covers the whole loop (together ${f.got.toFixed(1)} ≥ 0.9×${f.expect.toFixed(1)} min)`);
    const p = r.routes.find((x) => x.participantId === "p")?.distanceKm ?? 0;
    ok(p >= 0.9 * L(r), `the finisher runs the whole spine (${p.toFixed(2)} ≥ 0.9×${L(r).toFixed(2)} km)`);
  }, "waypoint-finish-anchor");

  finish();
}

void main();
