// ---------------------------------------------------------------------------
// Route engine — orchestrates the whole calculate pipeline (build steps 5–7).
//
//   validate → build the shared "spine" → ORS (parallel, cached) → time each
//   route → together-time analysis → per-participant schedules → summary
//
// The shared spine is what the flock flies together along:
//   • If the flock nominated waypoints, the spine IS those waypoints (in order),
//     and any with a stop time become shared stops everyone pauses at.
//   • Otherwise a sensible auto-corridor is synthesised from everyone's starts.
//
// Each route is start → spine → (loop-forming return detour) → home, so it comes
// back as a LOOP rather than retracing an out-and-back. The return detour is
// also where homeward distance is padded to hit a runner's target distance.
//
// A runner with NO distance preference is treated as "happy to stay with the
// flock": no padding, no target — their route simply follows the whole spine,
// which maximises their time flying together.
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
  RouteStop,
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

// Distance guard: don't auto-route someone more than this to reach the corridor.
const MAX_ANCHOR_DETOUR_KM = 12;
// Auto-corridor length is sized off the smallest *constrained* target distance
// so a short-distance runner isn't forced over budget, clamped to this range.
const CORRIDOR_MIN_KM = 0.8;
const CORRIDOR_MAX_KM = 4.0;
// Minimum distance the loop-forming return detour adds — enough that the way
// home is a different path from the way out (a real loop, not an out-and-back).
const MIN_LOOP_ADD_KM = 0.7;
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

/** A shared stop everyone pauses at (derived from a waypoint with a stop time). */
interface SharedStop {
  location: LatLng;
  durationSec: number;
  name: string;
}

/** Target distance (km) respecting any hard cap, or null if unconstrained. */
function targetDistanceKm(p: Participant): number | null {
  if (p.preferredDistance == null && p.maxDistance == null) return null;
  let t = p.preferredDistance ?? p.maxDistance ?? DEFAULT_LOOP_DISTANCE_KM;
  if (p.maxDistance != null) t = Math.min(t, p.maxDistance);
  return t;
}

function centroid(points: LatLng[]): LatLng {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

/** Auto-corridor (near→far) the flock converges onto when no waypoints exist. */
function buildCorridor(starts: LatLng[], corridorKm: number): [LatLng, LatLng] {
  const anchor = centroid(starts);
  const minLat = Math.min(...starts.map((s) => s.lat));
  const minLng = Math.min(...starts.map((s) => s.lng));
  const maxLat = Math.max(...starts.map((s) => s.lat));
  const maxLng = Math.max(...starts.map((s) => s.lng));
  const bearing = bearingRad({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng });
  const near = destinationPoint(anchor, bearing + Math.PI, corridorKm / 2);
  const far = destinationPoint(anchor, bearing, corridorKm / 2);
  return [near, far];
}

/**
 * A detour point that, inserted between `from` and `to`, adds ~addKm of
 * crow-flies distance (perpendicular triangle bump at the midpoint). This is what
 * turns the way home into a loop instead of a retrace.
 */
function paddingDetour(from: LatLng, to: LatLng, addKm: number): LatLng {
  const L = crowKm(from, to);
  if (L < 0.05) {
    return destinationPoint(from, Math.PI / 2, addKm / 2); // degenerate: poke east
  }
  const half = L / 2;
  const newHalf = (L + addKm) / 2;
  const h = Math.sqrt(Math.max(0, newHalf * newHalf - half * half));
  return destinationPoint(midpoint(from, to), bearingRad(from, to) + Math.PI / 2, h);
}

function spineStraightKm(start: LatLng, spine: LatLng[], home: LatLng): number {
  let km = crowKm(start, spine[0]) + crowKm(spine[spine.length - 1], home);
  for (let i = 1; i < spine.length; i++) km += crowKm(spine[i - 1], spine[i]);
  return km;
}

export interface CalcResult {
  routes: ComputedRoute[];
  sharedSegments: SharedSegment[];
  summary: {
    totalTogetherMinutes: number;
    pairwiseSummary: PairSummary[];
  };
  warnings: CalcWarning[];
  skipped: boolean;
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

// --- Timing ------------------------------------------------------------------

interface BuiltRoute {
  computed: ComputedRoute;
  timed: TimedRoute;
}

/** Apply pace + (aligned) departure timing and shared stops to an ORS geometry. */
function timeRoute(
  participant: Participant,
  ors: OrsRoute,
  sharedStops: SharedStop[],
  departSec: number,
): BuiltRoute {
  const pace = participant.preferredPace ?? DEFAULT_PACE_SEC_PER_KM;
  const coords = ors.geometry.coordinates as [number, number][];

  // Cumulative-distance points (clock times added after stops are placed).
  const points: TimedPoint[] = [];
  let cumKm = 0;
  for (let i = 0; i < coords.length; i++) {
    const ll: LatLng = { lat: coords[i][1], lng: coords[i][0] };
    if (i > 0) {
      const prev = { lat: coords[i - 1][1], lng: coords[i - 1][0] };
      cumKm += distanceMeters(prev, ll) / 1000;
    }
    points.push({ ll, cumKm, clockSec: 0 });
  }

  // Snap each shared stop to its nearest vertex on this route.
  const stops: RouteStop[] = sharedStops
    .map((s) => {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = distanceMeters(points[i].ll, s.location);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return { idx: best, durationSec: s.durationSec, name: s.name, location: points[best].ll };
    })
    .sort((a, b) => a.idx - b.idx);

  // Clock time at each point = depart + moving time + duration of stops passed.
  for (let i = 0; i < points.length; i++) {
    let restBefore = 0;
    for (const st of stops) if (st.idx < i) restBefore += st.durationSec;
    points[i].clockSec = departSec + points[i].cumKm * pace + restBefore;
  }

  const totalRestSec = stops.reduce((s, st) => s + st.durationSec, 0);
  const distanceKm = cumKm;
  const movingSec = distanceKm * pace;
  const arrivalSec = departSec + movingSec + totalRestSec;

  const displayWaypoints: LatLng[] = [
    participant.startLocation,
    ...stops.map((s) => s.location),
    participant.finishLocation ?? participant.startLocation,
  ];

  const computed: ComputedRoute = {
    participantId: participant.id,
    waypoints: displayWaypoints,
    geometry: ors.geometry,
    distanceKm: Number(distanceKm.toFixed(2)),
    estimatedDurationMinutes: Math.round(movingSec / 60),
    departureTime: secToTime(departSec),
    arrivalTime: secToTime(arrivalSec),
    schedule: [],
  };

  const timed: TimedRoute = {
    participantId: participant.id,
    paceSecPerKm: pace,
    points,
    stops,
  };

  log.debug("route timed", {
    participantId: participant.id,
    pace,
    distanceKm: computed.distanceKm,
    orsDistanceKm: Number(ors.distanceKm.toFixed(2)),
    departure: computed.departureTime,
    arrival: computed.arrivalTime,
    stops: stops.length,
    points: points.length,
  });

  return { computed, timed };
}

// --- Per-participant route generation ---------------------------------------

async function generateRoute(
  participant: Participant,
  spine: LatLng[] | null,
  isAutoCorridor: boolean,
): Promise<OrsRoute> {
  const start = participant.startLocation;
  const finish = participant.finishLocation;
  const home = finish ?? start;
  const isLoop = finish == null;
  const target = targetDistanceKm(participant);

  // The auto-corridor is skipped for runners too far from it; explicit waypoints
  // are always honoured (the flock chose them).
  let useSpine = spine != null;
  if (useSpine && spine && isAutoCorridor) {
    const detourKm = crowKm(start, spine[0]);
    if (detourKm > MAX_ANCHOR_DETOUR_KM) {
      useSpine = false;
      log.debug("skipping auto-corridor (too far)", {
        participantId: participant.id,
        detourKm: round2(detourKm),
      });
    }
  }

  if (useSpine && spine) {
    return routeThroughSpine(participant, spine, home, target);
  }
  if (isLoop) {
    const len = target ?? DEFAULT_LOOP_DISTANCE_KM;
    const key = `loop:${round5(start)}:${len}`;
    return cachedRoute(key, () => getRoundTrip(start, len));
  }
  const key = `p2p:${round5(start)};${round5(home)}`;
  return cachedRoute(key, () => getRoute([start, home]));
}

/** Cumulative distance (km) along a geometry to the vertex nearest `target`. */
function approachKmTo(geometry: GeoJSON.LineString, target: LatLng): number {
  const coords = geometry.coordinates as [number, number][];
  let cumKm = 0;
  let bestCum = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const ll: LatLng = { lat: coords[i][1], lng: coords[i][0] };
    if (i > 0) cumKm += distanceMeters({ lat: coords[i - 1][1], lng: coords[i - 1][0] }, ll) / 1000;
    const d = distanceMeters(ll, target);
    if (d < bestD) {
      bestD = d;
      bestCum = cumKm;
    }
  }
  return bestCum;
}

/**
 * Route start → spine → loop-forming detour → home. The detour both makes the
 * route a loop and pads homeward distance toward the target. When the runner is
 * unconstrained (target null) we just use the minimum loop detour and let the
 * distance fall where it may. One linear correction lands a target within
 * tolerance; capped at 2 ORS calls.
 */
async function routeThroughSpine(
  participant: Participant,
  spine: LatLng[],
  home: LatLng,
  target: number | null,
): Promise<OrsRoute> {
  const start = participant.startLocation;
  const spineEnd = spine[spine.length - 1];
  const baseStraight = spineStraightKm(start, spine, home);

  let addKm = MIN_LOOP_ADD_KM;
  if (target != null) addKm = Math.max(MIN_LOOP_ADD_KM, target - baseStraight * ROAD_FACTOR);

  let ors: OrsRoute | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const detour = paddingDetour(spineEnd, home, addKm);
    const waypoints = [start, ...spine, detour, home];
    const key = `spine:${waypoints.map(round5).join(";")}`;
    ors = await cachedRoute(key, () => getRoute(waypoints));
    const actual = ors.distanceKm;
    log.debug("spine distance pass", {
      participantId: participant.id,
      attempt,
      target,
      actual: round2(actual),
      addKm: round2(addKm),
      offPct: target ? Math.round((Math.abs(actual - target) / target) * 100) : null,
    });
    if (target == null || attempt === 1) break;
    if (Math.abs(actual - target) / target <= DISTANCE_TOLERANCE) break;
    addKm = Math.max(MIN_LOOP_ADD_KM, addKm + (target - actual) / ROAD_FACTOR);
  }

  return ors!;
}

// --- Warnings ----------------------------------------------------------------

function buildWarnings(participant: Participant, computed: ComputedRoute): CalcWarning[] {
  const warnings: CalcWarning[] = [];
  const pace = participant.preferredPace ?? DEFAULT_PACE_SEC_PER_KM;

  if (participant.earliestStartTime && participant.latestFinishTime) {
    const availableMin =
      (timeToSec(participant.latestFinishTime) - timeToSec(participant.earliestStartTime)) / 60;
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

  if (participant.maxDistance != null && computed.distanceKm > participant.maxDistance + 0.6) {
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
  const waypoints = session.waypoints ?? [];

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

  // Shared stops come from waypoints that have a stop time.
  const sharedStops: SharedStop[] = waypoints
    .filter((w) => w.stopMinutes > 0)
    .map((w) => ({ location: w.location, durationSec: w.stopMinutes * 60, name: w.name }));

  // Build the shared spine: explicit waypoints, else an auto-corridor.
  let spine: LatLng[] | null = null;
  let isAutoCorridor = false;
  if (waypoints.length > 0) {
    spine = waypoints.map((w) => w.location);
  } else if (withStart.length >= 2) {
    const constrained = withStart
      .map(targetDistanceKm)
      .filter((t): t is number => t != null);
    const sizingBasis = constrained.length ? Math.min(...constrained) : DEFAULT_LOOP_DISTANCE_KM;
    const corridorKm = clamp(0.4 * sizingBasis, CORRIDOR_MIN_KM, CORRIDOR_MAX_KM);
    spine = buildCorridor(withStart.map((p) => p.startLocation), corridorKm);
    isAutoCorridor = true;
    log.info("auto-corridor", { flockId: session.id, sizingBasis, corridorKm: round2(corridorKm) });
  }

  log.info("calculating", {
    flockId: session.id,
    participants: withStart.length,
    waypoints: waypoints.length,
    sharedStops: sharedStops.length,
    spine: spine ? `${spine.length} pts` : "none",
  });

  const settled = await Promise.allSettled(
    withStart.map((p) => generateRoute(p, spine, isAutoCorridor)),
  );

  // Collect successful raw routes; failures become warnings.
  const raw: { participant: Participant; ors: OrsRoute }[] = [];
  const warnings: CalcWarning[] = [];
  settled.forEach((r, i) => {
    const participant = withStart[i];
    if (r.status === "fulfilled") {
      raw.push({ participant, ors: r.value });
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

  // Departure alignment — the key to maximising together-time. Stagger who leaves
  // when so everyone reaches the shared spine's start at the same moment, then
  // flies it in sync. The longest approach leaves at their earliest time; the
  // others leave later (never earlier than their own earliest).
  const departById = new Map<string, number>();
  const spineStart = spine?.[0] ?? null;
  const approaches = raw.map(({ participant, ors }) => {
    const pace = participant.preferredPace ?? DEFAULT_PACE_SEC_PER_KM;
    const earliest = timeToSec(participant.earliestStartTime ?? DEFAULT_DEPARTURE);
    const usesSpine =
      spineStart != null &&
      (!isAutoCorridor || crowKm(participant.startLocation, spineStart) <= MAX_ANCHOR_DETOUR_KM);
    const approachSec = usesSpine && spineStart ? approachKmTo(ors.geometry, spineStart) * pace : 0;
    return { id: participant.id, earliest, approachSec, usesSpine };
  });
  const aligning = approaches.filter((a) => a.usesSpine);
  if (aligning.length >= 2) {
    const T = Math.max(...aligning.map((a) => a.earliest + a.approachSec));
    for (const a of approaches) {
      departById.set(a.id, a.usesSpine ? T - a.approachSec : a.earliest);
    }
    log.info("departure alignment", {
      arriveAtSpine: secToTime(T),
      departures: approaches.map((a) => ({ id: a.id.slice(0, 4), at: secToTime(departById.get(a.id)!) })),
    });
  } else {
    for (const a of approaches) departById.set(a.id, a.earliest);
  }

  const built: BuiltRoute[] = raw.map(({ participant, ors }) => {
    const b = timeRoute(participant, ors, sharedStops, departById.get(participant.id)!);
    warnings.push(...buildWarnings(participant, b.computed));
    return b;
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
      intervalsByParticipant.set(
        b.timed.participantId,
        result.companionIntervals.get(b.timed.participantId) ?? [],
      );
    }
  }

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
