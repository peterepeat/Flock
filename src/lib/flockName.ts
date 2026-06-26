// ---------------------------------------------------------------------------
// The flock's display name. The user can SET one (in The run); otherwise it is
// AUTO-derived from the plan — ridiculously simple, gracefully degrading:
//
//   [time] [run to <dest> via <stops> | loop from <origin> via <stops> | run | loop]
//
//   7am run
//   7:30am loop from Federation Square
//   8:30am run to National Gallery of Victoria
//   9:30am run to National Gallery of Victoria via Convent Bakery
//
// LOOSELY COUPLED: reads only routing OUTPUT (computedRoutes / flockRoute) + the
// run config — never the engine (src/lib/flock/*). A null/empty plan still yields
// a sensible word ("run").
// ---------------------------------------------------------------------------

import { waypointNameIsAuto } from "./flockGpx";
import type { FlockSession, FlockWaypoint, LatLng } from "./types";

const LOOP_M = 200; // spine endpoints within this ⇒ the run loops back on itself
const ORIGIN_M = 400; // a named waypoint this close to the start ⇒ it's the meeting point ("loop from")

/** The name to show by the title: the user's set name if any, else the auto name. */
export function flockDisplayName(session: FlockSession): string {
  const set = session.name?.trim();
  return set ? set : deriveFlockName(session);
}

/** The auto name from the plan's OUTPUT. Always returns something speakable. */
export function deriveFlockName(session: FlockSession): string {
  const time = flockTimeLabel(session);
  const named = (session.waypoints ?? []).filter((w) => w.name?.trim() && !waypointNameIsAuto(w));
  const line = session.flockRoute;
  const loop = isLoop(line);

  let shape: string;
  if (named.length === 0) {
    shape = loop ? "loop" : "run";
  } else if (loop && line && near(named[0].location, toLatLng(line.coordinates[0])) < ORIGIN_M) {
    // The first named waypoint sits at the start ⇒ it's the meeting point we loop from;
    // any further named waypoints are stops along the loop.
    shape = withVias(`loop from ${named[0].name}`, named.slice(1));
  } else {
    // Point-to-point, or an out-and-back to a FAR named waypoint: the last is the destination.
    shape = withVias(`run to ${named[named.length - 1].name}`, named.slice(0, -1));
  }

  return [time, shape].filter(Boolean).join(" ") || "Flock";
}

function withVias(base: string, vias: FlockWaypoint[]): string {
  const names = vias.map((w) => w.name);
  if (names.length === 0) return base;
  const via = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} & ${names[1]}` : `${names[0]} & ${names.length - 1} more`;
  return `${base} via ${via}`;
}

/** The flock's headline start time — IDENTICAL to The run's summary (runSummary in FlockPanel uses this
 *  too) so the two never disagree: an Auto flock reads "7am" (the nominal default); a set departure /
 *  "be there by" reads its own time. Deliberately NOT the per-runner computed departures — a connector
 *  runner setting off early would make the name show a different time than The run does. */
export function flockTimeLabel(session: FlockSession): string {
  const a = session.startAnchor;
  return a.kind === "auto" ? "7am" : clock12(a.time);
}

function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${period}` : `${h12}${period}`;
}

function isLoop(line: FlockSession["flockRoute"]): boolean {
  if (!line || line.coordinates.length < 3) return false;
  return near(toLatLng(line.coordinates[0]), toLatLng(line.coordinates[line.coordinates.length - 1])) < LOOP_M;
}

const toLatLng = (c: number[]): LatLng => ({ lat: c[1], lng: c[0] }); // GeoJSON is [lng, lat]

// Haversine metres — kept local so this stays free of any engine/geo coupling.
function near(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
