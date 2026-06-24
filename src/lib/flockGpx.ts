// ---------------------------------------------------------------------------
// Flock ROUTE ⇄ GPX 1.1 (distinct from gpx.ts, which exports one runner's run).
//
// The flock route — our ordered shared waypoints — is, in GPX terms, a <rte> of
// <rtept>s. The computed backbone (the snapped spine) is a <trk> so the file is
// followable on a watch. Stops stay <rtept>s flagged with <sym>/<type> + a
// flock:stopMinutes extension. Our data rides in a flock: extensions namespace;
// foreign data we didn't model is carried through verbatim (per-waypoint gpxExtra
// + a document-level passthrough blob) so an export → edit-elsewhere → re-import
// cycle loses nothing.
// ---------------------------------------------------------------------------

import { closestPointOnSegment, distanceMeters } from "./geo";
import { createLogger } from "./logger";
import type { FlockSession, FlockWaypoint, LatLng } from "./types";

const log = createLogger("flock-gpx");

export const FLOCK_NS = "https://flock.run/gpx/1";
const SIMPLIFY_EPSILON_M = 60; // Douglas–Peucker tolerance for dense tracks
const SIMPLIFY_MAX_PTS = 40; // hard cap on waypoints from a track
// A named top-level <wpt> within this perpendicular distance of the imported
// track/route counts as "on" it — a deliberate stop / join / exit point — so we
// insert it into the waypoint sequence at its along-route position. Beyond this
// it's treated as an unrelated POI and left untouched in gpxPassthrough.
const ON_TRACK_TOL_M = 75;
// A named <wpt> this close to an EXISTING route point is the SAME place: we fold
// its name onto that point (if the point is still auto-named) instead of inserting
// a near-zero-length duplicate.
const COINCIDE_TOL_M = 20;

export interface GpxResult {
  xml: string;
  filename: string;
}

export interface ParsedGpx {
  waypoints: Omit<FlockWaypoint, "id">[];
  gpxPassthrough: string | null;
  warnings: string[];
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Combine a waypoint's foreign passthrough children with our own flock
 * extensions into valid XML. GPX allows only ONE <extensions> per element, so
 * flock:stopMinutes is injected into an existing (foreign) <extensions> if there
 * is one, else wrapped in a fresh block.
 */
function mergeExtra(gpxExtra: string, flockInner: string): string {
  const extra = gpxExtra.trim();
  if (!flockInner) return extra;
  if (extra.includes("</extensions>")) {
    return extra.replace("</extensions>", `${flockInner}</extensions>`);
  }
  return `${extra}<extensions>${flockInner}</extensions>`;
}

function rtept(
  lat: number,
  lon: number,
  name: string,
  stopMinutes: number,
  gpxExtra: string | undefined,
): string {
  const stop = stopMinutes > 0;
  const lines = [
    `    <rtept lat="${lat}" lon="${lon}">`,
    `      <name>${xmlEscape(name)}</name>`,
  ];
  if (stop) {
    lines.push(`      <sym>Flag, Blue</sym>`);
    lines.push(`      <type>stop</type>`);
  }
  const flockInner = stop ? `<flock:stopMinutes>${stopMinutes}</flock:stopMinutes>` : "";
  const extra = mergeExtra(gpxExtra ?? "", flockInner);
  if (extra) lines.push(`      ${extra}`);
  lines.push(`    </rtept>`);
  return lines.join("\n");
}

/** Build a GPX document for the flock route (waypoints → <rte>, backbone → <trk>). */
export function buildFlockGpx(session: FlockSession): GpxResult | null {
  const waypoints = session.waypoints ?? [];
  if (waypoints.length === 0) {
    log.warn("no route to export", { flockId: session.id });
    return null;
  }

  const rtepts = waypoints
    .map((w) => rtept(w.location.lat, w.location.lng, w.name, w.stopMinutes, w.gpxExtra))
    .join("\n");

  // The computed backbone as a followable track (when a calculation has run).
  let trk = "";
  const coords = session.flockRoute?.coordinates ?? [];
  if (coords.length > 1) {
    const trkpts = coords.map((c) => `      <trkpt lat="${c[1]}" lon="${c[0]}" />`).join("\n");
    trk =
      `  <trk>\n    <name>Flock route — path</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>\n`;
  }

  // Foreign top-level elements from a prior import, re-emitted unchanged.
  const passthrough = session.gpxPassthrough ? `${session.gpxPassthrough.trim()}\n` : "";

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Flock" xmlns="http://www.topografix.com/GPX/1/1" xmlns:flock="${FLOCK_NS}">\n` +
    `  <metadata>\n` +
    `    <name>Flock route</name>\n` +
    `    <time>${new Date().toISOString()}</time>\n` +
    `  </metadata>\n` +
    `  <rte>\n` +
    `    <name>Flock route</name>\n` +
    `${rtepts}\n` +
    `  </rte>\n` +
    trk +
    passthrough +
    `</gpx>\n`;

  log.info("flock route gpx built", {
    flockId: session.id,
    rtepts: waypoints.length,
    stops: waypoints.filter((w) => w.stopMinutes > 0).length,
    trkpts: coords.length,
    passthroughBytes: passthrough.length,
  });

  return { xml, filename: "flock-route.gpx" };
}

// --- import (browser only — uses DOMParser / XMLSerializer) -----------------

/** Perpendicular distance (m) from p to segment a→b, via a local flat projection. */
function perpDistanceM(p: LatLng, a: LatLng, b: LatLng): number {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((a.lat * Math.PI) / 180);
  const bx = (b.lng - a.lng) * mLng;
  const by = (b.lat - a.lat) * mLat;
  const px = (p.lng - a.lng) * mLng;
  const py = (p.lat - a.lat) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
}

/**
 * Douglas–Peucker simplification, then an even-downsample cap, returning the KEPT
 * INDICES into `pts` (endpoints always kept). Indices — rather than points — so the
 * caller can read each kept point's along-track distance from a shared cumulative
 * profile and merge named waypoints in by position. Pure (no DOM).
 */
export function simplifyTrackIdx(pts: LatLng[]): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const dp = (lo: number, hi: number): number[] => {
    if (hi - lo < 2) return [lo, hi]; // adjacent — nothing between to drop
    let maxD = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistanceM(pts[i], pts[lo], pts[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > SIMPLIFY_EPSILON_M && idx !== -1) {
      return [...dp(lo, idx).slice(0, -1), ...dp(idx, hi)]; // splice on the shared vertex
    }
    return [lo, hi];
  };
  let idxs = dp(0, n - 1);
  if (idxs.length > SIMPLIFY_MAX_PTS) {
    const step = (idxs.length - 1) / (SIMPLIFY_MAX_PTS - 1);
    const down: number[] = [idxs[0]];
    for (let i = 1; i < SIMPLIFY_MAX_PTS - 1; i++) down.push(idxs[Math.round(i * step)]);
    down.push(idxs[idxs.length - 1]);
    idxs = down;
  }
  return idxs;
}

/** Cumulative along-line distance (km) at each vertex of a polyline. Pure. */
export function cumKmOf(coords: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceMeters(coords[i - 1], coords[i]) / 1000);
  return cum;
}

/**
 * Project `p` onto a polyline (given its precomputed cumulative-km profile):
 * the closest approach, returned as { alongKm, perpM }. alongKm orders a point
 * along the route; perpM gates whether it's "on" the route. Pure.
 */
export function projectOnPolyline(
  coords: LatLng[],
  cum: number[],
  p: LatLng,
): { alongKm: number; perpM: number } {
  let bestKm = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const foot = closestPointOnSegment(p, coords[i], coords[i + 1]);
    const d = distanceMeters(p, foot);
    if (d < bestD) {
      bestD = d;
      bestKm = cum[i] + distanceMeters(coords[i], foot) / 1000;
    }
  }
  return { alongKm: bestKm, perpM: bestD };
}

export interface RouteItem {
  wp: Omit<FlockWaypoint, "id">;
  alongKm: number; // position along the route geometry, for ordering
}

/**
 * Merge named POIs (top-level <wpt>s) into an ordered route, BY POSITION.
 *
 * Each named POI is projected onto the route geometry; if it lands within
 * ON_TRACK_TOL_M it is woven into the sequence at its along-route distance — so the
 * corridor the engine routes (waypoints are mandatory vertices in array order) still
 * runs Start → … → POI → … → Finish without back-tracking. A POI sitting essentially
 * on an existing (auto-named) point folds its real name onto that point instead of
 * adding a duplicate. POIs off the route are left for the caller to keep verbatim.
 *
 * `named` and the returned `onTrack` are index-aligned so the caller can mark exactly
 * the absorbed source elements consumed (and leave the rest in gpxPassthrough). Pure.
 */
export function mergeNamedIntoRoute(
  base: RouteItem[],
  geom: { coords: LatLng[]; cum: number[]; totalKm: number },
  named: Omit<FlockWaypoint, "id">[],
): { waypoints: Omit<FlockWaypoint, "id">[]; onTrack: boolean[] } {
  const onTrack = named.map(() => false);
  if (named.length === 0 || geom.coords.length < 2 || geom.totalKm <= 0) {
    return { waypoints: base.map((b) => b.wp), onTrack };
  }
  const items: RouteItem[] = base.map((b) => ({ ...b }));
  const EPS_KM = 1e-4; // ~0.1 m — keep POIs strictly interior so endpoints stay first/last
  named.forEach((poi, i) => {
    // Sitting on top of an existing AUTO-named point (a shape placeholder / bare rtept)?
    // Fold the real name onto it rather than add a coincident duplicate. We only fold onto
    // PLACEHOLDERS: a real-named point is left untouched and the POI falls through to the
    // on-route insert below — so a POI near a named point (or near another POI placed this
    // pass) is still represented, never silently dropped. Keep the placeholder's own foreign
    // gpxExtra when the POI brings none.
    let bi = -1;
    let bd = Infinity;
    for (let k = 0; k < items.length; k++) {
      const d = distanceMeters(poi.location, items[k].wp.location);
      if (d < bd) {
        bd = d;
        bi = k;
      }
    }
    if (bd <= COINCIDE_TOL_M && bi >= 0 && isAutoWaypointName(items[bi].wp.name)) {
      const keepExtra = poi.gpxExtra ?? items[bi].wp.gpxExtra;
      items[bi] = {
        ...items[bi],
        wp: {
          ...items[bi].wp,
          name: poi.name,
          address: poi.address || poi.name,
          ...(keepExtra ? { gpxExtra: keepExtra } : {}),
        },
      };
      onTrack[i] = true; // absorbed (named an existing placeholder) → don't keep in passthrough
      return;
    }
    const { alongKm, perpM } = projectOnPolyline(geom.coords, geom.cum, poi.location);
    if (perpM <= ON_TRACK_TOL_M) {
      const km = Math.min(Math.max(alongKm, EPS_KM), geom.totalKm - EPS_KM);
      items.push({ wp: poi, alongKm: km });
      onTrack[i] = true; // inserted into the route at its along-route position
    }
    // else: genuinely off the route → caller keeps it verbatim in gpxPassthrough
  });
  const waypoints = items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => a.it.alongKm - b.it.alongKm || a.idx - b.idx) // stable: base order wins on ties
    .map((x) => x.it.wp);
  return { waypoints, onTrack };
}

const serialize = (node: Node) => new XMLSerializer().serializeToString(node);
const childByName = (el: Element, name: string) =>
  Array.from(el.children).find((c) => c.localName === name) ?? null;

/** Foreign children of an rtept/wpt we don't model — re-emitted verbatim on export. */
function captureExtra(el: Element, isFlockStop: boolean): string | undefined {
  const keep: string[] = [];
  for (const child of Array.from(el.children)) {
    const tag = child.localName;
    if (tag === "name") continue;
    if (isFlockStop && (tag === "sym" || tag === "type")) continue; // we regenerate these
    if (tag === "extensions") {
      const clone = child.cloneNode(true) as Element;
      Array.from(clone.children).forEach((c) => {
        if (c.namespaceURI === FLOCK_NS) c.remove(); // our data — regenerated
      });
      if (clone.children.length > 0) keep.push(serialize(clone));
      continue;
    }
    keep.push(serialize(child));
  }
  return keep.length ? keep.join("") : undefined;
}

// The placeholder name a point gets when its GPX element carried no <name> (a
// bare <wpt>/<rtept>, or a <trk> simplified to shape points). These convey no
// place info, so an importer can reverse-geocode them into real names — see
// isAutoWaypointName + reverseGeocodeBatch.
const AUTO_WAYPOINT_NAME = "Waypoint";

/** True if `name` is one parseFlockGpx auto-assigned (no <name> in the GPX). */
export function isAutoWaypointName(name: string): boolean {
  return (
    name === AUTO_WAYPOINT_NAME || name === "Start" || name === "Finish" || /^Point \d+$/.test(name)
  );
}

function pointFromEl(el: Element): Omit<FlockWaypoint, "id"> | null {
  const lat = Number(el.getAttribute("lat"));
  const lng = Number(el.getAttribute("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const stopEl = el.getElementsByTagNameNS(FLOCK_NS, "stopMinutes")[0];
  const stopMinutes = stopEl ? Math.max(0, parseInt(stopEl.textContent ?? "0", 10) || 0) : 0;
  const name = childByName(el, "name")?.textContent?.trim() || AUTO_WAYPOINT_NAME;
  const extra = captureExtra(el, stopMinutes > 0);
  return { location: { lat, lng }, address: name, name, stopMinutes, ...(extra ? { gpxExtra: extra } : {}) };
}

/** "A", "A and B", "A, B and C" — for naming placed/skipped waypoints in a warning. */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Parse a GPX document into flock waypoints + a verbatim passthrough of
 * everything we didn't consume. Source priority: <rte> (route points, used
 * as-is) → <trk> (dense track, simplified + flagged for re-routing) → top-level
 * <wpt> (a pin list). In the <rte>/<trk> cases, named top-level <wpt>s that lie ON
 * the route (deliberate stops / join / exit points) are projected in at their
 * along-route position rather than dropped — see mergeNamedIntoRoute.
 * Browser-only (DOMParser).
 */
export function parseFlockGpx(xml: string): ParsedGpx {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("That file isn't valid GPX/XML.");
  }
  const gpx = doc.documentElement;
  if (!gpx || gpx.localName !== "gpx") {
    throw new Error("That file isn't a GPX document.");
  }

  const top = Array.from(gpx.children);
  const rtes = top.filter((e) => e.localName === "rte");
  const trks = top.filter((e) => e.localName === "trk");
  const wpts = top.filter((e) => e.localName === "wpt");

  let waypoints: Omit<FlockWaypoint, "id">[] = [];
  const consumed = new Set<Element>();

  // Named top-level <wpt>s (real <name>, not a bare/auto placeholder) paired with
  // their source element. In a <rte>/<trk> import these are deliberate POIs — stops,
  // join/exit points — that we weave into the route at their along-route position
  // rather than leave invisible in passthrough. Anonymous <wpt>s convey no place
  // and would only clutter the line, so they're excluded (and round-trip verbatim).
  const namedPairs = (rtes.length || trks.length)
    ? wpts
        .map((el) => ({ el, wp: pointFromEl(el) }))
        .filter((x): x is { el: Element; wp: Omit<FlockWaypoint, "id"> } =>
          x.wp != null && !isAutoWaypointName(x.wp.name),
        )
    : [];
  const namedPois = namedPairs.map((p) => p.wp);

  // Mark the absorbed POIs consumed (so they don't ALSO re-emit verbatim in
  // passthrough), and report what was woven in vs. left off the route.
  const reconcileNamed = (onTrack: boolean[], verb: string) => {
    namedPairs.forEach((p, i) => {
      if (onTrack[i]) consumed.add(p.el);
    });
    const placed = namedPois.filter((_, i) => onTrack[i]).map((w) => w.name);
    const skipped = namedPois.filter((_, i) => !onTrack[i]).map((w) => w.name);
    if (placed.length) {
      warnings.push(
        `${verb} ${placed.length} named ${placed.length === 1 ? "waypoint" : "waypoints"} on the route (${nameList(placed)}) — ${placed.length === 1 ? "a pass-through point" : "each a pass-through point"} you can switch to a stop.`,
      );
    }
    if (skipped.length) {
      warnings.push(
        `${skipped.length} named ${skipped.length === 1 ? "waypoint was" : "waypoints were"} not on the route (${nameList(skipped)}); kept in the file but left off the route.`,
      );
    }
  };

  if (rtes.length > 0) {
    const rte = rtes[0];
    consumed.add(rte);
    const baseWps = Array.from(rte.children)
      .filter((c) => c.localName === "rtept")
      .map(pointFromEl)
      .filter((w): w is Omit<FlockWaypoint, "id"> => w != null);
    const coords = baseWps.map((w) => w.location);
    const cum = cumKmOf(coords);
    const base: RouteItem[] = baseWps.map((wp, i) => ({ wp, alongKm: cum[i] }));
    const merged = mergeNamedIntoRoute(base, { coords, cum, totalKm: cum[cum.length - 1] ?? 0 }, namedPois);
    waypoints = merged.waypoints;
    reconcileNamed(merged.onTrack, "Placed");
  } else if (trks.length > 0) {
    const trk = trks[0];
    consumed.add(trk);
    const raw: LatLng[] = Array.from(trk.getElementsByTagName("trkpt"))
      .map((p) => ({ lat: Number(p.getAttribute("lat")), lng: Number(p.getAttribute("lon")) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
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
    const merged = mergeNamedIntoRoute(base, { coords: raw, cum, totalKm: cum[cum.length - 1] ?? 0 }, namedPois);
    waypoints = merged.waypoints;
    if (raw.length > 0) {
      warnings.push(
        `Imported a track of ${raw.length} points — simplified to ${base.length} waypoints. The flock engine re-routes between them, so the exact path may shift.`,
      );
    }
    reconcileNamed(merged.onTrack, "Kept");
  } else if (wpts.length > 0) {
    wpts.forEach((w) => consumed.add(w));
    waypoints = wpts
      .map(pointFromEl)
      .filter((w): w is Omit<FlockWaypoint, "id"> => w != null);
  } else {
    warnings.push("No route, track, or waypoints found in that GPX.");
  }

  // Everything top-level we didn't consume (and don't regenerate) is preserved.
  const passthroughEls = top.filter((e) => e.localName !== "metadata" && !consumed.has(e));
  const gpxPassthrough = passthroughEls.length
    ? passthroughEls.map((e) => serialize(e)).join("\n")
    : null;

  log.info("flock route gpx parsed", {
    source: rtes.length ? "rte" : trks.length ? "trk" : wpts.length ? "wpt" : "none",
    waypoints: waypoints.length,
    passthroughEls: passthroughEls.length,
  });

  return { waypoints, gpxPassthrough, warnings };
}
