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

import { createLogger } from "./logger";
import type { FlockSession, FlockWaypoint, LatLng } from "./types";

const log = createLogger("flock-gpx");

export const FLOCK_NS = "https://flock.run/gpx/1";
const SIMPLIFY_EPSILON_M = 60; // Douglas–Peucker tolerance for dense tracks
const SIMPLIFY_MAX_PTS = 40; // hard cap on waypoints from a track

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

/** Douglas–Peucker simplification, then an even-downsample cap. Endpoints kept. */
function simplifyTrack(pts: LatLng[]): LatLng[] {
  const dp = (s: LatLng[]): LatLng[] => {
    if (s.length < 3) return s;
    let maxD = 0;
    let idx = 0;
    for (let i = 1; i < s.length - 1; i++) {
      const d = perpDistanceM(s[i], s[0], s[s.length - 1]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > SIMPLIFY_EPSILON_M) {
      return [...dp(s.slice(0, idx + 1)).slice(0, -1), ...dp(s.slice(idx))];
    }
    return [s[0], s[s.length - 1]];
  };
  let out = pts.length > 2 ? dp(pts) : pts.slice();
  if (out.length > SIMPLIFY_MAX_PTS) {
    const step = (out.length - 1) / (SIMPLIFY_MAX_PTS - 1);
    const down: LatLng[] = [out[0]];
    for (let i = 1; i < SIMPLIFY_MAX_PTS - 1; i++) down.push(out[Math.round(i * step)]);
    down.push(out[out.length - 1]);
    out = down;
  }
  return out;
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

/**
 * Parse a GPX document into flock waypoints + a verbatim passthrough of
 * everything we didn't consume. Source priority: <rte> (route points, used
 * as-is) → <trk> (dense track, simplified + flagged for re-routing) → top-level
 * <wpt> (a pin list). Browser-only (DOMParser).
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

  if (rtes.length > 0) {
    const rte = rtes[0];
    consumed.add(rte);
    waypoints = Array.from(rte.children)
      .filter((c) => c.localName === "rtept")
      .map(pointFromEl)
      .filter((w): w is Omit<FlockWaypoint, "id"> => w != null);
  } else if (trks.length > 0) {
    const trk = trks[0];
    consumed.add(trk);
    const raw: LatLng[] = Array.from(trk.getElementsByTagName("trkpt"))
      .map((p) => ({ lat: Number(p.getAttribute("lat")), lng: Number(p.getAttribute("lon")) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const simplified = simplifyTrack(raw);
    waypoints = simplified.map((ll, i) => ({
      location: ll,
      address: i === 0 ? "Start" : i === simplified.length - 1 ? "Finish" : `Point ${i + 1}`,
      name: i === 0 ? "Start" : i === simplified.length - 1 ? "Finish" : `Point ${i + 1}`,
      stopMinutes: 0,
    }));
    if (raw.length > 0) {
      warnings.push(
        `Imported a track of ${raw.length} points — simplified to ${waypoints.length} waypoints. The flock engine re-routes between them, so the exact path may shift.`,
      );
    }
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
