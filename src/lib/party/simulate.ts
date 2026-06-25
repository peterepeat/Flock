// ---------------------------------------------------------------------------
// Flock Party — the simulation core.
//
// This is the loosely-coupled seam between the routing MODEL and the playful
// animation. It NEVER touches the engine: it reads only the stable output
// contract a session already carries — each runner's ComputedRoute (geometry +
// timed schedule) plus the shared segments — and turns it into something an
// animation can sample: where every runner is at any clock time, and the
// discrete moments worth celebrating (set-offs, meet-ups, farewells, coffee
// stops, finishes).
//
// Why this is exact (not a re-derivation of the model): a runner's schedule
// segments are ordered along their route and their distances sum to the
// geometry's length (project.ts builds them that way). So each segment maps to a
// contiguous arc-length WINDOW on the polyline, and position is a plain
// interpolation along it — robust even on loops that revisit a point (where a
// nearest-vertex match would be ambiguous). All timing comes straight from the
// schedule; we add no model assumptions.
// ---------------------------------------------------------------------------

import { bearingRad, distanceMeters } from "@/lib/geo";
import type { ComputedRoute, FlockSession, LatLng, Participant, SharedSegment } from "@/lib/types";
import { timeToSec } from "@/lib/units";

/**
 * Flock Party IS the locked state: a flock that is fully locked (all three section
 * locks) AND has a real, timed route to show. Locking starts the looping party;
 * unlocking ends it. Shared by the controller (mount) and the mobile nav (hide).
 */
export function isPartyActive(session: FlockSession | null | undefined): boolean {
  if (!session) return false;
  const l = session.locks;
  const locked = !!(l && l.run && l.route && l.runners);
  const playable = !!session.computedRoutes?.some(
    (r) => r.arrivalTime !== r.departureTime && r.geometry.coordinates.length > 1,
  );
  return locked && playable;
}

export type RunnerState = "before" | "running" | "resting" | "finished";

/** A runner sampled at one instant — everything the renderer needs to draw them. */
export interface RunnerFrame {
  pos: LatLng;
  headingDeg: number; // 0..360, clockwise from north (direction of travel)
  state: RunnerState;
  moving: boolean; // running AND actually covering ground (not a 0-length leg)
  companions: string[]; // who they're flocking with right now (participant ids)
  /** 0→1 progress through the whole personal run (start→finish), for trails / fade-in. */
  progress: number;
  /** Current running pace (sec/km) on the active leg; null when resting / not yet running / done. */
  paceSecPerKm: number | null;
}

export type PartyEventKind =
  | "start" // a runner sets off
  | "meet" // the flock grows here (a convergence)
  | "farewell" // a pair parts ways
  | "stop-arrive" // reach a planned stop (coffee)
  | "stop-depart" // leave a planned stop
  | "finish"; // a runner reaches their end

/** A discrete moment in the run, sorted by time. Speech bubbles + flags hang off these. */
export interface PartyEvent {
  id: string; // stable key for React
  t: number; // seconds since midnight
  kind: PartyEventKind;
  /** The runner(s) the bubble belongs to. */
  subjectIds: string[];
  /** The counterpart(s): who you meet / wave goodbye to. Empty otherwise. */
  withIds: string[];
  location: LatLng;
  label?: string; // a stop's name
}

/** A waving flag planted on the map. A stop flag stands while runners are there;
 *  a finish flag stays planted to the end. */
export interface PartyFlag {
  id: string;
  kind: "stop" | "finish";
  location: LatLng;
  plantedAt: number; // sec — flag appears
  removeAt: number | null; // sec — stop flags fold up when the last runner leaves; finish = null (stays)
  label?: string;
}

/** One runner's sampleable track. */
export interface RunnerTrack {
  id: string;
  startSec: number;
  finishSec: number;
  start: LatLng;
  finish: LatLng;
  hasStops: boolean;
  parked: boolean; // an infeasible runner with ~no route — stands at their spot
  frameAt(t: number): RunnerFrame;
}

export interface PartySim {
  tStart: number; // earliest set-off across the flock (sec)
  tEnd: number; // latest finish across the flock (sec)
  tracks: RunnerTrack[];
  byId: Record<string, RunnerTrack>;
  events: PartyEvent[];
  flags: PartyFlag[];
  finaleAt: number; // when the WHOLE flock is done → fireworks (== tEnd)
}

// A run leg shorter than this (m) doesn't really "move" — hold heading, skip bounce.
const MOVE_EPS_M = 1;

// Stops are grouped by a ~11m lat/lng grid snap (round4) + the arrival minute, so a
// café shared by several runners (identical pointAtKm coords) plants ONE flag.
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const placeKey = (p: LatLng) => `${round4(p.lat)},${round4(p.lng)}`;

interface GeoIndex {
  pts: LatLng[];
  cum: number[]; // cumulative metres at each vertex; cum[0]=0
  total: number; // total length (m)
}

/** Cumulative arc-length index over a [lng,lat] GeoJSON line. */
function indexGeometry(line: GeoJSON.LineString): GeoIndex {
  const pts: LatLng[] = line.coordinates.map(([lng, lat]) => ({ lat, lng }));
  const cum = new Array<number>(pts.length);
  cum[0] = 0;
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + distanceMeters(pts[i - 1], pts[i]);
  return { pts, cum, total: cum[cum.length - 1] ?? 0 };
}

/** Locate a point + local heading at `m` metres along the indexed line (clamped). */
function locate(idx: GeoIndex, m: number): { pos: LatLng; headingDeg: number } {
  const { pts, cum, total } = idx;
  if (pts.length === 0) return { pos: { lat: 0, lng: 0 }, headingDeg: 0 };
  if (pts.length === 1 || total === 0) return { pos: pts[0], headingDeg: 0 };
  const target = Math.max(0, Math.min(total, m));
  // Binary search for the segment [i, i+1] containing `target`.
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo); // segment ends at vertex i
  const a = pts[i - 1];
  const b = pts[i];
  const segLen = cum[i] - cum[i - 1];
  const f = segLen > 0 ? (target - cum[i - 1]) / segLen : 0;
  const pos = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
  const headingDeg = (((bearingRad(a, b) * 180) / Math.PI) % 360 + 360) % 360;
  return { pos, headingDeg };
}

// A schedule segment lifted onto the geometry: a time window [t0,t1] mapped to an
// arc-length window [m0,m1] (m0===m1 for a rest — the runner holds position).
interface Leg {
  t0: number;
  t1: number;
  m0: number;
  m1: number;
  rest: boolean;
  companions: string[];
  paceSecPerKm: number | null; // the leg's running pace (null on a rest)
}

function buildTrack(route: ComputedRoute): RunnerTrack {
  const idx = indexGeometry(route.geometry);
  const startSec = timeToSec(route.departureTime);
  const finishSec = Math.max(startSec, timeToSec(route.arrivalTime));

  // Sum the schedule's own distances; map them proportionally onto the real
  // geometry length so minute/2-dp rounding never drifts the endpoints.
  const schedKm = route.schedule.reduce((s, seg) => s + (seg.type === "run" ? seg.distanceKm : 0), 0);
  const scale = schedKm > 0 ? idx.total / (schedKm * 1000) : 0;

  const legs: Leg[] = [];
  let cumM = 0;
  for (const seg of route.schedule) {
    const t0 = timeToSec(seg.startTime);
    const t1 = timeToSec(seg.endTime);
    if (seg.type === "rest") {
      legs.push({ t0, t1, m0: cumM, m1: cumM, rest: true, companions: seg.companionIds, paceSecPerKm: null });
    } else {
      const m1 = cumM + seg.distanceKm * 1000 * scale;
      // Pace comes straight off the schedule OUTPUT (never the engine); fall back to the leg's own
      // duration/distance if a run segment is somehow missing its pace.
      const paceSecPerKm = seg.paceSecPerKm ?? (seg.distanceKm > 0 ? (t1 - t0) / seg.distanceKm : null);
      legs.push({ t0, t1, m0: cumM, m1, rest: false, companions: seg.companionIds, paceSecPerKm });
      cumM = m1;
    }
  }
  // A track with no real distance (a parked / degenerate runner) just stands still.
  const parked = idx.total < MOVE_EPS_M || legs.length === 0;
  const start = idx.pts[0] ?? { lat: 0, lng: 0 };
  const finish = idx.pts[idx.pts.length - 1] ?? start;
  const hasStops = route.schedule.some((s) => s.type === "rest");
  const span = Math.max(1, finishSec - startSec);

  function frameAt(t: number): RunnerFrame {
    const progress = Math.max(0, Math.min(1, (t - startSec) / span));
    if (parked) {
      return { pos: start, headingDeg: 0, state: t < startSec ? "before" : t >= finishSec ? "finished" : "running", moving: false, companions: [], progress, paceSecPerKm: null };
    }
    if (t <= startSec) {
      const h = locate(idx, 0);
      return { pos: start, headingDeg: h.headingDeg, state: "before", moving: false, companions: [], progress: 0, paceSecPerKm: null };
    }
    if (t >= finishSec) {
      return { pos: finish, headingDeg: locate(idx, idx.total).headingDeg, state: "finished", moving: false, companions: [], progress: 1, paceSecPerKm: null };
    }
    // Active leg: the last one whose window has opened (covers minute-rounding gaps).
    let leg = legs[0];
    for (const l of legs) {
      if (l.t0 <= t) leg = l;
      else break;
    }
    if (leg.rest) {
      const h = locate(idx, leg.m0);
      return { pos: h.pos, headingDeg: h.headingDeg, state: "resting", moving: false, companions: leg.companions, progress, paceSecPerKm: null };
    }
    const f = leg.t1 > leg.t0 ? Math.max(0, Math.min(1, (t - leg.t0) / (leg.t1 - leg.t0))) : 1;
    const m = leg.m0 + (leg.m1 - leg.m0) * f;
    const h = locate(idx, m);
    return { pos: h.pos, headingDeg: h.headingDeg, state: "running", moving: leg.m1 - leg.m0 > MOVE_EPS_M, companions: leg.companions, progress, paceSecPerKm: leg.paceSecPerKm };
  }

  return { id: route.participantId, startSec, finishSec, start, finish, hasStops, parked, frameAt };
}

// ---------------------------------------------------------------------------
// Events + flags — derived from the same output, dedup-ed so the show reads clean.
// ---------------------------------------------------------------------------

function buildEvents(
  routes: ComputedRoute[],
  shared: SharedSegment[],
  tracks: Record<string, RunnerTrack>,
): { events: PartyEvent[]; flags: PartyFlag[] } {
  const events: PartyEvent[] = [];
  const flags: PartyFlag[] = [];
  const present = new Set(routes.map((r) => r.participantId));
  let n = 0;
  const eid = (k: string) => `ev-${k}-${n++}`;

  // Set-offs + finishes (one each per runner).
  for (const r of routes) {
    const tr = tracks[r.participantId];
    if (!tr || tr.parked) continue;
    events.push({ id: eid("start"), t: tr.startSec, kind: "start", subjectIds: [r.participantId], withIds: [], location: tr.start });
    events.push({ id: eid("finish"), t: tr.finishSec, kind: "finish", subjectIds: [r.participantId], withIds: [], location: tr.finish });
    flags.push({ id: `flag-finish-${r.participantId}`, kind: "finish", location: tr.finish, plantedAt: tr.finishSec, removeAt: null });
  }

  // Meet-ups — the flock GROWS here. sharedSegments already mark a convergence
  // (a join), with the exact place + time + who, so we lean on that rather than
  // re-detecting. Absent flag (legacy) is treated as a meet, matching the map.
  for (const s of shared) {
    if (s.isConvergence === false) continue;
    const first = s.geometry.coordinates[0];
    if (!first) continue;
    events.push({
      id: eid("meet"),
      t: timeToSec(s.startTime),
      kind: "meet",
      subjectIds: s.participantIds.filter((id) => present.has(id)),
      withIds: [],
      location: { lat: first[1], lng: first[0] },
    });
  }

  // Farewells — a pair that was flocking and isn't on the next leg. Read each
  // runner's own companion timeline; dedupe the symmetric pair by {pair, minute}.
  const seenBye = new Set<string>();
  for (const r of routes) {
    const sched = r.schedule;
    for (let i = 0; i < sched.length - 1; i++) {
      const here = new Set(sched[i].companionIds);
      const next = new Set(sched[i + 1].companionIds);
      for (const other of here) {
        if (next.has(other) || !present.has(other)) continue;
        const tMin = Math.round(timeToSec(sched[i].endTime) / 60);
        const key = [r.participantId, other].sort().join("|") + "@" + tMin;
        if (seenBye.has(key)) continue;
        seenBye.add(key);
        events.push({
          id: eid("bye"),
          t: timeToSec(sched[i].endTime),
          kind: "farewell",
          subjectIds: [r.participantId],
          withIds: [other],
          location: sched[i].endLocation,
        });
      }
    }
  }

  // Planned stops — coffee flags. Group rests that coincide in place+time so a
  // shared café plants ONE flag and a single "coffee!" for everyone there.
  type StopGroup = { t0: number; t1: number; loc: LatLng; ids: string[]; label?: string };
  const groups = new Map<string, StopGroup>();
  for (const r of routes) {
    for (const seg of r.schedule) {
      if (seg.type !== "rest") continue;
      const t0 = timeToSec(seg.startTime);
      const key = `${placeKey(seg.startLocation)}@${Math.round(t0 / 60)}`;
      const g = groups.get(key);
      if (g) {
        g.ids.push(r.participantId);
        g.t1 = Math.max(g.t1, timeToSec(seg.endTime));
        g.label = g.label ?? seg.label;
      } else {
        groups.set(key, { t0, t1: timeToSec(seg.endTime), loc: seg.startLocation, ids: [r.participantId], label: seg.label });
      }
    }
  }
  for (const g of groups.values()) {
    events.push({ id: eid("stop-in"), t: g.t0, kind: "stop-arrive", subjectIds: g.ids, withIds: [], location: g.loc, label: g.label });
    events.push({ id: eid("stop-out"), t: g.t1, kind: "stop-depart", subjectIds: g.ids, withIds: [], location: g.loc, label: g.label });
    flags.push({ id: `flag-stop-${placeKey(g.loc)}-${Math.round(g.t0 / 60)}`, kind: "stop", location: g.loc, plantedAt: g.t0, removeAt: g.t1, label: g.label });
  }

  events.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
  return { events, flags };
}

/**
 * Build a complete, sampleable simulation from a session's existing routing
 * output. Returns null when there's nothing to play (no runner has a real,
 * timed route yet).
 */
export function buildPartySim(input: {
  participants: Participant[];
  routes: ComputedRoute[];
  sharedSegments: SharedSegment[];
}): PartySim | null {
  // `participants` is accepted for a stable call site, but the sim needs none of it —
  // every position + event is derived from the routes' geometry and timed schedule alone.
  const { routes, sharedSegments } = input;
  if (!routes.length) return null;

  const tracks = routes.map((r) => buildTrack(r));
  const byId: Record<string, RunnerTrack> = {};
  for (const t of tracks) byId[t.id] = t;

  const live = tracks.filter((t) => !t.parked);
  if (!live.length) return null; // everyone parked — no show to play

  const tStart = Math.min(...live.map((t) => t.startSec));
  const tEnd = Math.max(...live.map((t) => t.finishSec));
  if (!(tEnd > tStart)) return null; // degenerate window

  const { events, flags } = buildEvents(routes, sharedSegments, byId);

  return { tStart, tEnd, tracks, byId, events, flags, finaleAt: tEnd };
}

/**
 * Cluster runners who are flocking together at one instant into groups (connected
 * components of the MUTUAL-companion graph) — so the renderer can draw a single
 * "the flock" avatar where several runners overlap instead of stacking them.
 * Input: id → that runner's current companion ids. Edges count only when BOTH
 * sides name each other (symmetric), which keeps a minute-rounding boundary from
 * briefly half-merging a pair. Output: one sorted id-array per group (singletons
 * included). Deterministic given a stable id order.
 */
export function flockGroups(companionsById: Record<string, string[]>): string[][] {
  const ids = Object.keys(companionsById);
  const present = new Set(ids);
  const adj: Record<string, string[]> = {};
  for (const id of ids) adj[id] = [];
  for (const a of ids) {
    for (const b of companionsById[a]) {
      if (present.has(b) && companionsById[b]?.includes(a)) adj[a].push(b);
    }
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const x = stack.pop() as string;
      comp.push(x);
      for (const y of adj[x]) if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
    groups.push(comp.sort());
  }
  return groups;
}
