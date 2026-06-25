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

  finish();
}

main();
