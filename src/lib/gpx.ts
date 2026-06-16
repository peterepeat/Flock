// ---------------------------------------------------------------------------
// GPX 1.1 generation for a single participant.
//
// Emits a schema-valid document (metadata → wpt* → rte) so it loads cleanly in
// Garmin Connect, Strava and Komoot. The route geometry becomes <rtept>s; each
// together-stretch start and each rest stop become annotated <wpt>s.
// ---------------------------------------------------------------------------

import { distanceMeters } from "./geo";
import { createLogger } from "./logger";
import type { FlockSession, LatLng } from "./types";

const log = createLogger("gpx");

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function lineLengthKm(coords: number[][]): number {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const a: LatLng = { lat: coords[i - 1][1], lng: coords[i - 1][0] };
    const b: LatLng = { lat: coords[i][1], lng: coords[i][0] };
    km += distanceMeters(a, b) / 1000;
  }
  return km;
}

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "runner";
}

export interface GpxResult {
  xml: string;
  filename: string;
}

export function buildGpx(session: FlockSession, participantId: string): GpxResult | null {
  const participant = session.participants.find((p) => p.id === participantId);
  const route = session.computedRoutes?.find((r) => r.participantId === participantId);
  if (!participant || !route) {
    log.warn("no route to export", { flockId: session.id, participantId });
    return null;
  }

  const nameOf = (id: string) => session.participants.find((p) => p.id === id)?.name ?? "your flock";

  const waypoints: string[] = [];

  // Each together-period gets a convergence ("Meet … here") and a divergence
  // ("Part ways …") waypoint — one pair per period, at the actual transitions.
  for (const seg of session.sharedSegments ?? []) {
    if (!seg.participantIds.includes(participantId)) continue;
    const others = seg.participantIds.filter((id) => id !== participantId).map(nameOf);
    const coords = seg.geometry.coordinates;
    const start = coords[0];
    const end = coords[coords.length - 1];
    if (!start) continue;
    const km = lineLengthKm(coords);
    waypoints.push(
      `  <wpt lat="${start[1]}" lon="${start[0]}">\n` +
        `    <name>Meet ${xmlEscape(others.join(" + "))} here</name>\n` +
        `    <desc>~${seg.startTime}. You'll fly together for about ${km.toFixed(1)}km.</desc>\n` +
        `  </wpt>`,
    );
    if (end && coords.length > 2) {
      waypoints.push(
        `  <wpt lat="${end[1]}" lon="${end[0]}">\n` +
          `    <name>Part ways with ${xmlEscape(others.join(" + "))}</name>\n` +
          `    <desc>You go your own way from here.</desc>\n` +
          `  </wpt>`,
      );
    }
  }

  // Rest stop → "Stop — [place]".
  const rest = route.schedule.find((s) => s.type === "rest");
  if (rest && participant.restStop) {
    const place = participant.restStop.locationAddress || "your stop";
    waypoints.push(
      `  <wpt lat="${rest.startLocation.lat}" lon="${rest.startLocation.lng}">\n` +
        `    <name>Stop — ${xmlEscape(place)}</name>\n` +
        `    <desc>Arrive ~${rest.startTime}. ${participant.restStop.durationMinutes} min stop. Leave ~${rest.endTime}.</desc>\n` +
        `  </wpt>`,
    );
  }

  const rtepts = route.geometry.coordinates
    .map((c) => `    <rtept lat="${c[1]}" lon="${c[0]}"><ele>0</ele></rtept>`)
    .join("\n");

  const title = `Run with the flock — ${participant.name}`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Flock" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n` +
    `    <name>${xmlEscape(title)}</name>\n` +
    `    <time>${new Date().toISOString()}</time>\n` +
    `  </metadata>\n` +
    (waypoints.length ? waypoints.join("\n") + "\n" : "") +
    `  <rte>\n` +
    `    <name>${xmlEscape(participant.name)}'s route</name>\n` +
    `${rtepts}\n` +
    `  </rte>\n` +
    `</gpx>\n`;

  log.info("gpx built", {
    flockId: session.id,
    participantId,
    rtepts: route.geometry.coordinates.length,
    waypoints: waypoints.length,
  });

  return { xml, filename: `flock-${slugify(participant.name)}.gpx` };
}
