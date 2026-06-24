// ---------------------------------------------------------------------------
// Route editing — where a new waypoint dragged out of the shared spine belongs.
//
// The flock corridor routes THROUGH session.waypoints in array order (buildSpine
// [W]), so a point pulled off the line mid-route must splice in BETWEEN the right
// neighbours, not append (which would detour the route out and back). We order by
// position ALONG the spine: project the grab point and every existing waypoint onto
// the spine, then count how many waypoints lie before the grab. Pure (no Leaflet).
// ---------------------------------------------------------------------------

import { cumKmOf, projectOnPolyline } from "./flockGpx";
import type { LatLng } from "./types";

/**
 * The index in [0, waypoints.length] at which to splice a waypoint dragged out of
 * the spine at `grab`, so the waypoint list stays ordered along the route. Counts
 * the existing waypoints whose along-spine position is at or before the grab's.
 */
export function insertionIndex(
  spine: LatLng[],
  waypoints: { location: LatLng }[],
  grab: LatLng,
): number {
  if (spine.length < 2) return waypoints.length;
  const cum = cumKmOf(spine);
  const grabKm = projectOnPolyline(spine, cum, grab).alongKm;
  let idx = 0;
  for (const w of waypoints) {
    if (projectOnPolyline(spine, cum, w.location).alongKm <= grabKm) idx++;
  }
  return idx;
}
