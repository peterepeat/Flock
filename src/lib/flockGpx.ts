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
import type { FlockSession } from "./types";

const log = createLogger("flock-gpx");

export const FLOCK_NS = "https://flock.run/gpx/1";

export interface GpxResult {
  xml: string;
  filename: string;
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
