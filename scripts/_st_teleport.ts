// Regression: a runner's drawn geometry must MATCH their schedule distance — no
// straight-line "teleport" stitch. Reproduces prod flock 6q3dar (Peter): a manual
// start far from the spine + a tight latest-finish makes the connector (built to the
// runner's join km) disagree with where the timed plan places their run, leaving a
// long straight gap in the geometry (geomLen >> distanceKm).
//   npx tsx scripts/_st_teleport.ts

import {
  calculateRoutes, person, wp, session, atPlace, auto, ok, suite, section, finish, lineKm,
} from "./_st_harness";

async function main() {
  suite("teleport");

  section("Peter's shape: manual start far NW + 45-min window, on a 2-waypoint corridor");
  const s = session(
    [
      person("peter", {
        startPin: atPlace(-37.7707, 144.9924, "Northcote"),
        finishPin: auto,
        earliestStartTime: "07:00",
        latestFinishTime: "07:45",
      }),
      person("collin", { startPin: atPlace(-37.8142, 144.9632, "Melbourne"), finishPin: auto }),
    ],
    [wp("bakery", -37.8025, 145.0035, 0), wp("balwyn", -37.792, 145.0842, 0)],
  );

  const r = await calculateRoutes(s);
  ok(r.skipped !== true, "not skipped");

  // (Under fake-ORS Peter's straight-line approach is shorter than the real road, so HERE he's feasible
  // — a short-coverage warning, not a park. Either way a non-parked runner must NOT be told to "try an
  // Auto start": that remedy belongs to an earliest-unreachable PARK alone.)
  const pw = r.warnings.find((w) => w.participantId === "peter");
  if (pw) ok(!/auto start/i.test(pw.message), `Peter's warning carries no spurious "Auto start" remedy: "${pw.message}"`);

  // The drawn route IS what the runner runs — its length must equal the schedule
  // distance. A mismatch means the geometry was stitched across a gap (the teleport).
  // (Under fake-ORS a connector is a straight line, so per-edge length isn't a signal;
  // geomLen vs distanceKm is.)
  for (const cr of r.routes) {
    const geomKm = lineKm(cr.geometry.coordinates);
    const schedKm = cr.distanceKm;
    section(`runner "${cr.participantId}"  geom=${geomKm.toFixed(2)}km  sched=${schedKm}km`);
    ok(
      Math.abs(geomKm - schedKm) < 0.5,
      `${cr.participantId}: geometry length (${geomKm.toFixed(2)}km) matches schedule distance (${schedKm}km) — no teleport`,
    );
  }

  section("mirror: manual FINISH far off-route + a tight latest (egress side)");
  const s2 = session(
    [
      person("zoe", {
        startPin: atPlace(-37.8142, 144.9632, "Melbourne"),
        finishPin: atPlace(-37.7707, 144.9924, "Northcote"),
        latestFinishTime: "07:35",
      }),
      person("dan", { startPin: atPlace(-37.8142, 144.9632, "Melbourne"), finishPin: auto }),
    ],
    [wp("bakery", -37.8025, 145.0035, 0), wp("balwyn", -37.792, 145.0842, 0)],
  );
  const r2 = await calculateRoutes(s2);
  ok(r2.skipped !== true, "mirror: not skipped");
  for (const cr of r2.routes) {
    const geomKm = lineKm(cr.geometry.coordinates);
    const schedKm = cr.distanceKm;
    section(`mirror runner "${cr.participantId}"  geom=${geomKm.toFixed(2)}km  sched=${schedKm}km`);
    ok(
      Math.abs(geomKm - schedKm) < 0.5,
      `${cr.participantId}: geometry length (${geomKm.toFixed(2)}km) matches schedule distance (${schedKm}km) — no teleport`,
    );
  }

  section("Auto-flock earliest-unreachable PARK → the remedy must be Auto-aware (not 'try Auto')");
  // `early`'s 07:00 latest pins the Auto flock to depart early; `late` is pinned at the bakery but
  // won't set off until 08:00, so the flock passes its join long before then and can't delay to wait
  // (that busts `early`'s latest). `late` is earliest-unreachable on an AUTO flock — the one config G3's
  // "never on Auto" assumption misses (it presumes an earliest-ONLY runner). The message must NOT say
  // "try an Auto start (the flock can wait for you)" — it IS Auto and it can't wait more.
  const s3 = session(
    [
      person("late", { startPin: atPlace(-37.8025, 145.0035, "Bakery"), earliestStartTime: "08:00" }),
      person("early", { startPin: atPlace(-37.8142, 144.9632, "Melbourne"), latestFinishTime: "07:00" }),
    ],
    [wp("bakery", -37.8025, 145.0035, 0), wp("balwyn", -37.792, 145.0842, 0)],
  );
  const r3 = await calculateRoutes(s3);
  // Whoever is parked earliest-unreachable on this Auto flock must get the Auto-aware remedy.
  const eu = r3.warnings.filter((w) =>
    /too far from the route|passes your join point|resting at your join point/.test(w.message));
  ok(eu.length > 0, "auto-park: an earliest-unreachable park is produced");
  for (const w of eu) {
    section(`auto-park warning "${w.participantId}": ${w.message}`);
    ok(!/auto start/i.test(w.message), `"${w.participantId}": no false "Auto start" remedy on an Auto flock`);
    ok(!/the flock can wait for you/i.test(w.message), `"${w.participantId}": doesn't promise the flock will wait`);
    ok(/closer|wider|widen|window|earlier/i.test(w.message), `"${w.participantId}": offers an actionable remedy`);
  }

  finish();
}

main();
