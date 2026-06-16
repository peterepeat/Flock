// ---------------------------------------------------------------------------
// Route engine — orchestrates the whole calculate pipeline (build steps 5–7).
//
//   validate → build waypoints → ORS (parallel, cached) → time each route →
//   together-time analysis → per-participant schedules → summary
//
// To make the signature "fly together" moment actually happen, loop/again-style
// runners are routed through a shared meeting point (the centroid of everyone's
// start). This is the spec's "candidate shared waypoint". A distance guard keeps
// the detour sane; when it would be excessive we fall back to an independent
// round-trip (loop) or a direct route (point-to-point), and the pair is honestly
// reported as too far apart.
//
// Every stage is logged with sizes + timings for fast fault diagnosis.
// ---------------------------------------------------------------------------

import { bearingRad, destinationPoint, distanceMeters } from "./geo";
import { createLogger } from "./logger";
import { getRoundTrip, getRoute, RouteError, type OrsRoute } from "./ors";
import { buildSchedule } from "./schedule";
import { analyzeTogether } from "./together";
import type {
  ComputedRoute,
  FlockSession,
  LatLng,
  Participant,
  SharedSegment,
} from "./types";
import type {
  CalcWarning,
  CompanionInterval,
  PairSummary,
  TimedPoint,
  TimedRoute,
} from "./routing-types";
import {
  DEFAULT_DEPARTURE,
  DEFAULT_LOOP_DISTANCE_KM,
  DEFAULT_PACE_SEC_PER_KM,
  secToTime,
  timeToSec,
} from "./units";

const log = createLogger("route-engine");

// Distance guard: don't detour more than this to reach the shared corridor.
const MAX_ANCHOR_DETOUR_KM = 12;
// Shared corridor length is sized off the smallest target distance in the group
// (so a short-distance runner isn't forced over budget), clamped to this range.
const CORRIDOR_MIN_KM = 0.6;
const CORRIDOR_MAX_KM = 2.0;
// Crow-flies → on-path distance estimate, used to seed the distance correction.
const ROAD_FACTOR = 1.3;
// Accept a route whose length is within this fraction of the target distance.
const DISTANCE_TOLERANCE = 0.12;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round2 = (v: number) => Number(v.toFixed(2));
const crowKm = (a: LatLng, b: LatLng) => distanceMeters(a, b) / 1000;
const midpoint = (a: LatLng, b: LatLng): LatLng => ({
  lat: (a.lat + b.lat) / 2,
  lng: (a.lng + b.lng) / 2,
});

/** The shared corridor everyone converges onto, then diverges from. */
interface Corridor {
  near: LatLng; // where the flock comes together
  far: LatLng; // turnaround point of the shared leg
}

function buildCorridor(starts: LatLng[], corridorKm: number): Corridor {
  const anchor = centroid(starts);
  // Orient the corridor along the spread of starts (SW corner → NE corner) so it
  // sits inside the group's area rather than off in an arbitrary direction.
  const minLat = Math.min(...starts.map((s) => s.lat));
  const minLng = Math.min(...starts.map((s) => s.lng));
  const maxLat = Math.max(...starts.map((s) => s.lat));
  const maxLng = Math.max(...starts.map((s) => s.lng));
  const bearing = bearingRad({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng });
  const near = destinationPoint(anchor, bearing + Math.PI, corridorKm / 2);
  const far = destinationPoint(anchor, bearing, corridorKm / 2);
  return { near, far };
}

/** Target distance for a participant (km), respecting any hard cap. */
function targetDistanceKm(p: Participant): number {
  let t = p.preferredDistance ?? p.maxDistance ?? DEFAULT_LOOP_DISTANCE_KM;
  if (p.maxDistance != null) t = Math.min(t, p.maxDistance);
  return t;
}

/**
 * A detour point that, inserted between `from` and `to`, adds ~addKm of
 * crow-flies distance (perpendicular triangle bump at the midpoint).
 */
function paddingDetour(from: LatLng, to: LatLng, addKm: number): LatLng {
  const L = crowKm(from, to);
  if (L < 0.05) {
    return destinationPoint(from, 0, addKm / 2); // degenerate: poke north
  }
  const half = L / 2;
  const newHalf = (L + addKm) / 2;
  const h = Math.sqrt(Math.max(0, newHalf * newHalf - half * half));
  return destinationPoint(midpoint(from, to), bearingRad(from, to) + Math.PI / 2, h);
}

function corridorWaypoints(
  start: LatLng,
  corridor: Corridor,
  home: LatLng,
  paddingKm: number,
  restLoc: LatLng | null,
): LatLng[] {
  const wp: LatLng[] = [start, corridor.near, corridor.far];
  if (paddingKm > 0.2) wp.push(paddingDetour(corridor.far, home, paddingKm));
  if (restLoc) wp.push(restLoc);
  wp.push(home);
  return wp;
}

export interface CalcResult {
  routes: ComputedRoute[];
  sharedSegments: SharedSegment[];
  summary: {
    totalTogetherMinutes: number;
    pairwiseSummary: PairSummary[];
  };
  warnings: CalcWarning[];
  skipped: boolean; // true when there was nothing to compute
}

// --- ORS result cache (per warm instance) -----------------------------------

const orsCache = new Map<string, OrsRoute>();

function round5(ll: LatLng): string {
  return `${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}`;
}

async function cachedRoute(key: string, fn: () => Promise<OrsRoute>): Promise<OrsRoute> {
  const hit = orsCache.get(key);
  if (hit) {
    log.debug("ORS cache hit", { key });
    return hit;
  }
  const route = await fn();
  orsCache.set(key, route);
  return route;
}

// --- Geometry / timing -------------------------------------------------------

function centroid(points: LatLng[]): LatLng {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

interface BuiltRoute {
  computed: ComputedRoute;
  timed: TimedRoute;
}

/** Apply pace + departure timing (and a rest stop) to an ORS geometry. */
function timeRoute(participant: Participant, ors: OrsRoute): BuiltRoute {
  const pace = participant.preferredPace ?? DEFAULT_PACE_SEC_PER_KM;
  const departSec = timeToSec(participant.earliestStartTime ?? DEFAULT_DEPARTURE);
  const coords = ors.geometry.coordinates as [number, number][];

  // Build cumulative-distance points.
  const points: TimedPoint[] = [];
  let cumKm = 0;
  for (let i = 0; i < coords.length; i++) {
    const ll: LatLng = { lat: coords[i][1], lng: coords[i][0] };
    if (i > 0) {
      const prev = { lat: coords[i - 1][1], lng: coords[i - 1][0] };
      cumKm += distanceMeters(prev, ll) / 1000;
    }
    points.push({ ll, cumKm, clockSec: departSec + cumKm * pace });
  }

  // Optional rest stop: place at the nearest vertex to a specific location, else
  // near the route midpoint. Shift all subsequent clock times by its duration.
  let restInsertedAtIdx: number | null = null;
  let restDurationSec = 0;
  if (participant.restStop?.wantsStop) {
    restDurationSec = (participant.restStop.durationMinutes ?? 30) * 60;
    if (participant.restStop.location) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = distanceMeters(points[i].ll, participant.restStop.location);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      restInsertedAtIdx = best;
    } else {
      const halfKm = cumKm / 2;
      restInsertedAtIdx = points.findIndex((p) => p.cumKm >= halfKm);
      if (restInsertedAtIdx < 0) restInsertedAtIdx = Math.floor(points.length / 2);
    }
    for (let i = restInsertedAtIdx + 1; i < points.length; i++) {
      points[i].clockSec += restDurationSec;
    }
  }

  const distanceKm = cumKm;
  const movingSec = distanceKm * pace;
  const arrivalSec = departSec + movingSec + restDurationSec;

  // Display waypoints: start, rest (if specific), finish.
  const waypoints: LatLng[] = [participant.startLocation];
  if (participant.restStop?.location) waypoints.push(participant.restStop.location);
  waypoints.push(participant.finishLocation ?? participant.startLocation);

  const computed: ComputedRoute = {
    participantId: participant.id,
    waypoints,
    geometry: ors.geometry,
    distanceKm: Number(distanceKm.toFixed(2)),
    estimatedDurationMinutes: Math.round(movingSec / 60),
    departureTime: secToTime(departSec),
    arrivalTime: secToTime(arrivalSec),
    schedule: [], // filled in after together-analysis
  };

  const timed: TimedRoute = {
    participantId: participant.id,
    paceSecPerKm: pace,
    points,
    restInsertedAtIdx,
    restDurationSec,
  };

  log.debug("route timed", {
    participantId: participant.id,
    pace,
    distanceKm: computed.distanceKm,
    orsDistanceKm: Number(ors.distanceKm.toFixed(2)),
    departure: computed.departureTime,
    arrival: computed.arrivalTime,
    rest: restInsertedAtIdx != null,
    points: points.length,
  });

  return { computed, timed };
}

// --- Per-participant route generation ---------------------------------------

async function generateForParticipant(
  participant: Participant,
  corridor: Corridor | null,
): Promise<BuiltRoute> {
  const start = participant.startLocation;
  const finish = participant.finishLocation;
  const home = finish ?? start;
  const isLoop = finish == null;
  const restLoc = participant.restStop?.location ?? null;
  const target = targetDistanceKm(participant);

  // Decide whether to route through the shared corridor.
  let useCorridor = false;
  if (corridor) {
    const detourKm = crowKm(start, corridor.near);
    useCorridor = detourKm <= MAX_ANCHOR_DETOUR_KM;
    log.debug("corridor decision", {
      participantId: participant.id,
      detourKm: round2(detourKm),
      target,
      useCorridor,
    });
  }

  let ors: OrsRoute;
  if (useCorridor && corridor) {
    ors = await routeThroughCorridorToTarget(participant, corridor, home, target);
  } else if (isLoop) {
    // Independent loop sized to the target distance (ORS round-trip is exact).
    const key = `loop:${round5(start)}:${target}`;
    ors = await cachedRoute(key, () => getRoundTrip(start, target));
  } else {
    // Direct point-to-point (with rest stop if specific).
    const waypoints: LatLng[] = [start];
    if (restLoc) waypoints.push(restLoc);
    waypoints.push(home);
    const key = `p2p:${waypoints.map(round5).join(";")}`;
    ors = await cachedRoute(key, () => getRoute(waypoints));
  }

  return timeRoute(participant, ors);
}

/**
 * Route through the shared corridor and pad the homeward leg to hit the target
 * distance. One linear correction (using the measured length) lands it within
 * tolerance; capped at 2 ORS calls per participant.
 */
async function routeThroughCorridorToTarget(
  participant: Participant,
  corridor: Corridor,
  home: LatLng,
  target: number,
): Promise<OrsRoute> {
  const start = participant.startLocation;
  const restLoc = participant.restStop?.location ?? null;
  const baseStraight =
    crowKm(start, corridor.near) + crowKm(corridor.near, corridor.far) + crowKm(corridor.far, home);

  let padding = Math.max(0, target - baseStraight * ROAD_FACTOR);
  let ors: OrsRoute | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const waypoints = corridorWaypoints(start, corridor, home, padding, restLoc);
    const key = `corr:${waypoints.map(round5).join(";")}`;
    ors = await cachedRoute(key, () => getRoute(waypoints));
    const actual = ors.distanceKm;
    const off = Math.abs(actual - target) / target;
    log.debug("corridor distance pass", {
      participantId: participant.id,
      attempt,
      target,
      actual: round2(actual),
      padding: round2(padding),
      offPct: Math.round(off * 100),
    });
    if (attempt === 1 || off <= DISTANCE_TOLERANCE) break;
    // Linear correction: padding moves road distance ~ROAD_FACTOR:1.
    padding = Math.max(0, padding + (target - actual) / ROAD_FACTOR);
  }

  return ors!;
}

// --- Warnings ----------------------------------------------------------------

function buildWarnings(participant: Participant, computed: ComputedRoute): CalcWarning[] {
  const warnings: CalcWarning[] = [];
  const pace = participant.preferredPace ?? DEFAULT_PACE_SEC_PER_KM;

  // Impossible time budget.
  if (participant.earliestStartTime && participant.latestFinishTime) {
    const availableMin = (timeToSec(participant.latestFinishTime) - timeToSec(participant.earliestStartTime)) / 60;
    const requiredMin = (computed.distanceKm * pace) / 60;
    if (availableMin > 0 && requiredMin > availableMin + 1) {
      warnings.push({
        participantId: participant.id,
        message: `At your pace, ${computed.distanceKm.toFixed(1)}km takes about ${Math.round(
          requiredMin,
        )} min — but you've only got ${Math.round(availableMin)} min. Adjust one or the other.`,
      });
    }
  }

  // Over the hard distance cap.
  if (participant.maxDistance != null && computed.distanceKm > participant.maxDistance + 0.5) {
    warnings.push({
      participantId: participant.id,
      message: `This route comes out at ${computed.distanceKm.toFixed(
        1,
      )}km, a bit past your ${participant.maxDistance}km limit.`,
    });
  }

  return warnings;
}

// --- Public entry point ------------------------------------------------------

export async function calculateRoutes(session: FlockSession): Promise<CalcResult> {
  const done = log.time("calculate", { flockId: session.id });
  const withStart = session.participants.filter((p) => p.startLocation);

  if (withStart.length === 0) {
    log.info("nothing to compute (no participants with a start)", { flockId: session.id });
    done({ skipped: true });
    return {
      routes: [],
      sharedSegments: [],
      summary: { totalTogetherMinutes: 0, pairwiseSummary: [] },
      warnings: [],
      skipped: true,
    };
  }

  // Shared corridor only makes sense with ≥2 participants. Size it off the
  // smallest target distance so a short-distance runner isn't pushed over budget.
  const minTarget = Math.min(...withStart.map(targetDistanceKm));
  const corridorKm = clamp(0.3 * minTarget, CORRIDOR_MIN_KM, CORRIDOR_MAX_KM);
  const corridor =
    withStart.length >= 2 ? buildCorridor(withStart.map((p) => p.startLocation), corridorKm) : null;
  log.info("calculating", {
    flockId: session.id,
    participants: withStart.length,
    minTarget,
    corridorKm: round2(corridorKm),
    corridor: corridor ? `${round5(corridor.near)}→${round5(corridor.far)}` : null,
  });

  // ORS calls in parallel; a failure for one participant becomes a warning.
  const settled = await Promise.allSettled(
    withStart.map((p) => generateForParticipant(p, corridor)),
  );

  const built: BuiltRoute[] = [];
  const warnings: CalcWarning[] = [];
  settled.forEach((r, i) => {
    const participant = withStart[i];
    if (r.status === "fulfilled") {
      built.push(r.value);
      warnings.push(...buildWarnings(participant, r.value.computed));
    } else {
      const err = r.reason;
      const code = err instanceof RouteError ? err.code : "ors-error";
      log.warn("participant route failed", { participantId: participant.id, code, error: String(err) });
      warnings.push({
        participantId: participant.id,
        message:
          code === "no-route"
            ? "We couldn't find a runnable route from here — try adjusting your start point."
            : "Routes are taking longer than usual — trying again shortly.",
      });
    }
  });

  // Together-time analysis (needs ≥2 routes).
  let sharedSegments: SharedSegment[] = [];
  let pairwiseSummary: PairSummary[] = [];
  let totalTogetherMinutes = 0;
  const intervalsByParticipant = new Map<string, CompanionInterval[]>();

  if (built.length >= 2) {
    const result = analyzeTogether(built.map((b) => b.timed));
    sharedSegments = result.shared;
    pairwiseSummary = result.pairwise;
    totalTogetherMinutes = result.totalTogetherMinutes;
    for (const b of built) {
      intervalsByParticipant.set(b.timed.participantId, result.companionIntervals.get(b.timed.participantId) ?? []);
    }
  }

  // Build per-participant schedules.
  for (const b of built) {
    const intervals = intervalsByParticipant.get(b.timed.participantId) ?? [];
    b.computed.schedule = buildSchedule(b.timed, intervals);
  }

  const routes = built.map((b) => b.computed);
  done({
    routes: routes.length,
    sharedSegments: sharedSegments.length,
    totalTogetherMinutes,
    warnings: warnings.length,
  });

  return {
    routes,
    sharedSegments,
    summary: { totalTogetherMinutes, pairwiseSummary },
    warnings,
    skipped: false,
  };
}
