// GPX import test — CATEGORY: named-waypoint placement.
//
// Covers the pure core of parseFlockGpx's <trk>/<rte> branches: a named top-level
// <wpt> that lies ON the imported track (a deliberate stop / join / exit point) must
// be woven into the waypoint sequence at its along-route position — not dropped into
// gpxPassthrough. Motivating case: "The Great Northern Marathon 2026.gpx" carries two
// rest-stop POIs (Francis Winifred @15km, Fawkner Bakery @26km) that sit exactly on a
// 1224-point track; both must appear, in order, as named pass-through waypoints.
//
// These exercise the DOM-free helpers directly (parseFlockGpx itself needs a browser
// DOMParser); the helpers ARE the algorithm — the DOM layer only marshals elements in.
//
// Run: npx tsx scripts/_st_gpx.ts

import {
  cumKmOf,
  isAutoWaypointName,
  mergeNamedIntoRoute,
  projectOnPolyline,
  simplifyTrackIdx,
  type RouteItem,
} from "../src/lib/flockGpx";
import { distanceMeters } from "../src/lib/geo";
import type { FlockWaypoint, LatLng } from "../src/lib/types";

// --- tiny self-contained harness (no engine/ORS import) ---------------------
let _pass = 0;
const _fails: string[] = [];
let _suite = "";
function suite(n: string) { _suite = n; console.log(`\n══ ${n} ══`); }
function ok(cond: boolean, msg: string) {
  if (cond) { _pass++; console.log(`  ✓ ${msg}`); }
  else { _fails.push(`[${_suite}] ${msg}`); console.log(`  ✗ FAIL  ${msg}`); }
}
function finish() {
  console.log(`\n${_fails.length === 0 ? "✅ ALL PASS" : `❌ ${_fails.length} FAILED`}  (${_pass}/${_pass + _fails.length})`);
  if (_fails.length) { console.log("FAILURES:"); for (const f of _fails) console.log("  · " + f); }
  process.exit(_fails.length ? 1 : 0);
}

// --- helpers ----------------------------------------------------------------
/** Interpolate n intermediate points along a→b (inclusive of both endpoints). */
function densify(a: LatLng, b: LatLng, n: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
  }
  return out;
}
function chain(anchors: LatLng[], perLeg: number): LatLng[] {
  const out: LatLng[] = [anchors[0]];
  for (let i = 1; i < anchors.length; i++) out.push(...densify(anchors[i - 1], anchors[i], perLeg).slice(1));
  return out;
}
/** Reproduce parseFlockGpx's <trk>-branch base construction (Start / Point N / Finish). */
function shapeBase(raw: LatLng[]): { base: RouteItem[]; cum: number[] } {
  const cum = cumKmOf(raw);
  const keptIdx = simplifyTrackIdx(raw);
  const base: RouteItem[] = keptIdx.map((idx, j) => ({
    alongKm: cum[idx],
    wp: {
      location: raw[idx],
      address: j === 0 ? "Start" : j === keptIdx.length - 1 ? "Finish" : `Point ${j + 1}`,
      name: j === 0 ? "Start" : j === keptIdx.length - 1 ? "Finish" : `Point ${j + 1}`,
      stopMinutes: 0,
    },
  }));
  return { base, cum };
}
const named = (name: string, location: LatLng, gpxExtra?: string): Omit<FlockWaypoint, "id"> => ({
  location, name, address: name, stopMinutes: 0, ...(gpxExtra ? { gpxExtra } : {}),
});
const idxOfName = (ws: Omit<FlockWaypoint, "id">[], n: string) => ws.findIndex((w) => w.name === n);

// Real coordinates from The Great Northern Marathon 2026.gpx.
const START: LatLng = { lat: -37.7796, lng: 144.9736 };
const FRANCIS: LatLng = { lat: -37.71861, lng: 144.91282 }; // rest stop @ ~15 km
const MID: LatLng = { lat: -37.705, lng: 144.94 };
const FAWKNER: LatLng = { lat: -37.69594, lng: 144.96875 }; // rest stop @ ~26 km
const FINISH: LatLng = { lat: -37.70, lng: 145.00 };

function main() {
  // ── simplifyTrackIdx ─────────────────────────────────────────────────────
  suite("simplifyTrackIdx — DP keeps endpoints, caps density");
  {
    const straight = densify(START, FINISH, 50); // collinear → only endpoints survive
    const idx = simplifyTrackIdx(straight);
    ok(idx[0] === 0 && idx[idx.length - 1] === straight.length - 1, "straight: keeps first & last");
    ok(idx.length === 2, "straight collinear line → 2 points");

    const withKink = chain([START, FRANCIS, FAWKNER, FINISH], 30); // real bends
    const kept = simplifyTrackIdx(withKink);
    ok(kept[0] === 0 && kept[kept.length - 1] === withKink.length - 1, "kinked: endpoints kept");
    ok(kept.length >= 3 && kept.length <= 40, "kinked: between 3 and the 40-cap");
    ok(kept.every((v, i) => i === 0 || v > kept[i - 1]), "kept indices strictly increasing");

    const tiny = simplifyTrackIdx([START]);
    ok(tiny.length === 1 && tiny[0] === 0, "single-point track → [0]");
    ok(simplifyTrackIdx([]).length === 0, "empty track → []");
  }

  // ── projectOnPolyline ────────────────────────────────────────────────────
  suite("projectOnPolyline — along/perp of a point vs a line");
  {
    const line = chain([START, FRANCIS, FAWKNER, FINISH], 20);
    const cum = cumKmOf(line);
    const onA = projectOnPolyline(line, cum, FRANCIS);
    const onB = projectOnPolyline(line, cum, FAWKNER);
    ok(onA.perpM < 1, "on-track POI (Francis): perp ≈ 0");
    ok(onB.perpM < 1, "on-track POI (Fawkner): perp ≈ 0");
    ok(onA.alongKm > 0 && onA.alongKm < onB.alongKm, "Francis is earlier along the route than Fawkner");
    ok(onB.alongKm < cum[cum.length - 1], "Fawkner is before the finish");
    // a point pushed ~perpendicular off the line reads a non-trivial perp distance
    const off = projectOnPolyline(line, cum, { lat: FRANCIS.lat + 0.01, lng: FRANCIS.lng });
    ok(off.perpM > 200, "POI ~1 km off the line: large perp distance");
  }

  // ── core: weave named on-track POIs into a <trk> import ───────────────────
  // The two rest stops are exact track anchors here, so DP keeps them as vertices and
  // each POI FOLDS its name onto that vertex (the no-duplicate path). Either way the
  // user-visible guarantees hold: both present, named, in route order, interior.
  suite("mergeNamedIntoRoute — Great Northern: two rest stops, in order");
  {
    const raw = chain([START, FRANCIS, MID, FAWKNER, FINISH], 40);
    const { base, cum } = shapeBase(raw);
    const totalKm = cum[cum.length - 1];
    // Pass the POIs in REVERSE document order to prove ordering is by position, not input.
    const pois = [named("Fawkner Bakery", FAWKNER, "<sym>Coffee</sym><type>Coffee</type>"), named("Francis Winifred", FRANCIS)];
    const { waypoints, onTrack } = mergeNamedIntoRoute(base, { coords: raw, cum, totalKm }, pois);

    ok(onTrack.length === 2 && onTrack.every(Boolean), "both POIs flagged on-track (→ consumed)");

    const fi = idxOfName(waypoints, "Francis Winifred");
    const ki = idxOfName(waypoints, "Fawkner Bakery");
    ok(fi !== -1 && ki !== -1, "both named waypoints present in the sequence");
    ok(fi < ki, "Francis Winifred (~15 km) ordered before Fawkner Bakery (~26 km)");
    ok(fi > 0 && ki < waypoints.length - 1, "both are interior (between Start and Finish)");
    ok(waypoints[0].name === "Start" && waypoints[waypoints.length - 1].name === "Finish", "endpoints stay Start / Finish");

    const francis = waypoints[fi];
    ok(francis.stopMinutes === 0, "imported POI is a pass-through (stopMinutes 0) — duration not invented");
    ok(distanceMeters(francis.location, FRANCIS) < 1, "POI sits at its own place");
    ok(!isAutoWaypointName(francis.name), "real name survives (won't be reverse-geocoded away)");
    ok(waypoints[ki].gpxExtra?.includes("Coffee") === true, "POI <sym>/<type> preserved via gpxExtra for round-trip");

    // waypoints come out sorted by along-route distance (monotone) → no corridor zig-zag
    const along = waypoints.map((w) => projectOnPolyline(raw, cum, w.location).alongKm);
    ok(along.every((v, i) => i === 0 || v >= along[i - 1] - 1e-6), "final sequence is monotone along the route");
  }

  // ── insertion proper: a POI mid-segment (far from any DP vertex) ──────────
  // Mirrors the real file, where a stop at 15 km lands between ~1 km-spaced simplified
  // shape points — so it is INSERTED as a new vertex (count grows), not folded.
  suite("mergeNamedIntoRoute — mid-segment POIs are inserted as new vertices");
  {
    // Two long straight legs; each POI is the (collinear, dropped-by-DP) midpoint of a leg.
    const P0: LatLng = { lat: -37.78, lng: 144.90 };
    const P1: LatLng = { lat: -37.78, lng: 145.00 }; // leg P0→P1 horizontal
    const P2: LatLng = { lat: -37.70, lng: 145.00 }; // bend
    const P3: LatLng = { lat: -37.70, lng: 144.90 }; // leg P2→P3 horizontal
    const STOP_A: LatLng = { lat: -37.78, lng: 144.95 }; // midpoint of leg P0→P1 (~4 km from P0/P1)
    const STOP_B: LatLng = { lat: -37.70, lng: 144.95 }; // midpoint of leg P2→P3
    const raw = chain([P0, P1, P2, P3], 50);
    const { base, cum } = shapeBase(raw);
    const totalKm = cum[cum.length - 1];
    const { waypoints, onTrack } = mergeNamedIntoRoute(
      base,
      { coords: raw, cum, totalKm },
      [named("Stop B", STOP_B), named("Stop A", STOP_A)], // reverse order on purpose
    );
    ok(onTrack.every(Boolean), "both mid-segment POIs on-track");
    ok(waypoints.length === base.length + 2, "both INSERTED as new vertices (count grows by 2)");
    const ai = idxOfName(waypoints, "Stop A");
    const bi = idxOfName(waypoints, "Stop B");
    ok(ai > 0 && bi < waypoints.length - 1 && ai < bi, "Stop A before Stop B, both interior");
    ok(distanceMeters(waypoints[ai].location, STOP_A) < 1, "inserted POI keeps its OWN coordinates");
  }

  // ── off-route POI: left for passthrough, not forced into the corridor ─────
  suite("mergeNamedIntoRoute — off-route POI is skipped (kept in passthrough)");
  {
    const raw = chain([START, FRANCIS, FAWKNER, FINISH], 30);
    const { base, cum } = shapeBase(raw);
    const totalKm = cum[cum.length - 1];
    const far = named("Faraway Cafe", { lat: -37.60, lng: 145.20 }); // km off the route
    const near = named("Francis Winifred", FRANCIS);
    const { waypoints, onTrack } = mergeNamedIntoRoute(base, { coords: raw, cum, totalKm }, [far, near]);
    ok(onTrack[0] === false, "off-route POI: NOT on track (stays in passthrough)");
    ok(onTrack[1] === true, "on-route POI alongside it: still placed");
    ok(idxOfName(waypoints, "Faraway Cafe") === -1, "off-route POI not inserted into the route");
    ok(idxOfName(waypoints, "Francis Winifred") !== -1, "on-route POI inserted");
  }

  // ── coincidence: fold a name onto an existing point, don't duplicate ──────
  suite("mergeNamedIntoRoute — coincident POI folds onto an existing point");
  {
    const raw = chain([START, FRANCIS, FAWKNER, FINISH], 30);
    const { base, cum } = shapeBase(raw);
    const totalKm = cum[cum.length - 1];
    // a POI essentially ON an auto-named shape point (pick an interior 'Point N')
    const interior = base.find((b) => /^Point \d+$/.test(b.wp.name))!;
    const onAuto = named("Trail Junction", { lat: interior.wp.location.lat, lng: interior.wp.location.lng });
    {
      const { waypoints, onTrack } = mergeNamedIntoRoute(base, { coords: raw, cum, totalKm }, [onAuto]);
      ok(onTrack[0] === true, "coincident-with-auto: absorbed (consumed)");
      ok(waypoints.length === base.length, "coincident-with-auto: no duplicate inserted");
      ok(idxOfName(waypoints, "Trail Junction") !== -1, "auto point renamed to the POI");
      ok(idxOfName(waypoints, interior.wp.name) === -1, "the old auto placeholder name is gone");
    }
    // same spot but the existing point already has a REAL name → don't clobber it, but the POI
    // is still represented (inserted), never silently dropped with a misleading "off route".
    {
      const realBase = base.map((b) => (b === interior ? { ...b, wp: { ...b.wp, name: "Existing Place", address: "Existing Place" } } : b));
      const { waypoints, onTrack } = mergeNamedIntoRoute(realBase, { coords: raw, cum, totalKm }, [onAuto]);
      ok(onTrack[0] === true, "coincident-with-real-name: POI inserted (represented, not dropped)");
      ok(idxOfName(waypoints, "Existing Place") !== -1, "the existing real name is NOT clobbered");
      ok(idxOfName(waypoints, "Trail Junction") !== -1, "the POI is also present (no data loss)");
      ok(waypoints.length === realBase.length + 1, "inserted as a distinct vertex beside it");
    }
  }

  // ── two named POIs at the SAME on-route spot: both placed, neither dropped ─
  suite("mergeNamedIntoRoute — two POIs at one spot are both represented");
  {
    const raw = chain([START, FAWKNER], 40); // a long straight leg
    const { base, cum } = shapeBase(raw);
    const totalKm = cum[cum.length - 1];
    const spot: LatLng = { lat: (START.lat + FAWKNER.lat) / 2, lng: (START.lng + FAWKNER.lng) / 2 }; // mid-leg, far from any vertex
    const { waypoints, onTrack } = mergeNamedIntoRoute(base, { coords: raw, cum, totalKm }, [named("Cafe One", spot), named("Cafe Two", spot)]);
    ok(onTrack[0] === true && onTrack[1] === true, "both same-spot POIs placed (no silent drop)");
    ok(idxOfName(waypoints, "Cafe One") !== -1 && idxOfName(waypoints, "Cafe Two") !== -1, "both names present");
    ok(waypoints.length === base.length + 2, "both inserted");
  }

  // ── guards: degenerate route, empty named list ───────────────────────────
  suite("mergeNamedIntoRoute — guards");
  {
    const base: RouteItem[] = [{ wp: named("Start", START), alongKm: 0 }];
    const r1 = mergeNamedIntoRoute(base, { coords: [START], cum: [0], totalKm: 0 }, [named("X", FRANCIS)]);
    ok(r1.waypoints.length === 1 && r1.onTrack[0] === false, "degenerate (<2 pts) route: nothing projected");

    const raw = chain([START, FAWKNER], 10);
    const sb = shapeBase(raw);
    const r2 = mergeNamedIntoRoute(sb.base, { coords: raw, cum: sb.cum, totalKm: sb.cum[sb.cum.length - 1] }, []);
    ok(r2.waypoints.length === sb.base.length && r2.onTrack.length === 0, "empty named list: base returned unchanged");
  }

  // ── the bare/auto filter the DOM layer applies before merging ─────────────
  suite("isAutoWaypointName — only real-named POIs are merge candidates");
  {
    ok(isAutoWaypointName("Waypoint"), "'Waypoint' (no <name>) is auto → excluded from merge");
    ok(isAutoWaypointName("Start") && isAutoWaypointName("Finish") && isAutoWaypointName("Point 7"), "shape placeholders are auto");
    ok(!isAutoWaypointName("Francis Winifred") && !isAutoWaypointName("Fawkner Bakery"), "real POI names are NOT auto → merged");
  }

  finish();
}

main();
