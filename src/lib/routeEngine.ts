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
// Length of the shared "fly together" corridor.
const CORRIDOR_KM = 1.6;

/** The shared corridor everyone converges onto, then diverges from. */
interface Corridor {
  near: LatLng; // where the flock comes together
  far: LatLng; // turnaround point of the shared leg
}

function buildCorridor(starts: LatLng[]): Corridor {
  const anchor = centroid(starts);
  // Orient the corridor along the spread of starts (SW corner → NE corner) so it
  // sits inside the group's area rather than off in an arbitrary direction.
  const minLat = Math.min(...starts.map((s) => s.lat));
  const minLng = Math.min(...starts.map((s) => s.lng));
  const maxLat = Math.max(...starts.map((s) => s.lat));
  const maxLng = Math.max(...starts.map((s) => s.lng));
  const bearing = bearingRad({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng });
  const near = destinationPoint(anchor, bearing + Math.PI, CORRIDOR_KM / 2);
  const far = destinationPoint(anchor, bearing, CORRIDOR_KM / 2);
  return { near, far };
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
  const isLoop = finish == null;

  // Decide whether to route through the shared corridor.
  let useCorridor = false;
  if (corridor) {
    const detourKm = distanceMeters(start, corridor.near) / 1000;
    useCorridor = detourKm <= MAX_ANCHOR_DETOUR_KM;
    log.debug("corridor decision", {
      participantId: participant.id,
      detourKm: Number(detourKm.toFixed(2)),
      useCorridor,
    });
  }

  let ors: OrsRoute;
  if (useCorridor && corridor) {
    // Converge → fly together along near→far → diverge.
    // start → near → far → (rest) → finish/start.
    const waypoints: LatLng[] = [start, corridor.near, corridor.far];
    if (participant.restStop?.location) waypoints.push(participant.restStop.location);
    waypoints.push(finish ?? start);
    const key = `p2p:${waypoints.map(round5).join(";")}`;
    ors = await cachedRoute(key, () => getRoute(waypoints));
  } else if (isLoop) {
    // Independent loop sized to the preferred distance.
    const lengthKm = participant.preferredDistance ?? DEFAULT_LOOP_DISTANCE_KM;
    const key = `loop:${round5(start)}:${lengthKm}`;
    ors = await cachedRoute(key, () => getRoundTrip(start, lengthKm));
  } else {
    // Direct point-to-point (with rest stop if specific).
    const waypoints: LatLng[] = [start];
    if (participant.restStop?.location) waypoints.push(participant.restStop.location);
    waypoints.push(finish!);
    const key = `p2p:${waypoints.map(round5).join(";")}`;
    ors = await cachedRoute(key, () => getRoute(waypoints));
  }

  return timeRoute(participant, ors);
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

  // Shared corridor only makes sense with ≥2 participants.
  const corridor = withStart.length >= 2 ? buildCorridor(withStart.map((p) => p.startLocation)) : null;
  log.info("calculating", {
    flockId: session.id,
    participants: withStart.length,
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
