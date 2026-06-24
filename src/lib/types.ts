// ---------------------------------------------------------------------------
// Flock data model.
//
// Internal storage conventions (NEVER deviate — the display layer converts):
//   • distance ......... kilometres
//   • pace ............. seconds per kilometre
//   • coordinates ...... decimal degrees (WGS84), { lat, lng }
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export type Unit = "km" | "miles";

// A location preference for where a runner joins (start) or leaves (finish) the flock.
// "auto" = no preference — the engine places it to maximise togetherness (the default).
// A pin to a waypoint travels WITH that waypoint if it moves and reverts to auto if the
// waypoint is deleted. A manual pin is a specific point off the route (a connector run).
export type LocationPin =
  | { kind: "auto" }
  | { kind: "waypoint"; waypointId: string }
  | { kind: "manual"; location: LatLng; address: string };

// When the flock departs. "auto" derives a sensible start from the runners' constraints:
// it stays 07:00 unless an earliest/latest constraint means a different start lets more of
// the flock run the full route together (and finish in time) — see resolveAutoStart. A
// departure time fixes the start; a waypoint time fixes when the flock reaches that
// waypoint, back-computing the departure ("be at the café at 09:00").
export type TimeAnchor =
  | { kind: "auto" }
  | { kind: "departure"; time: string } // "leave at 08:00"
  | { kind: "waypoint"; waypointId: string; time: string };

/**
 * A waypoint nominated for the whole flock — everyone's route passes through it,
 * in order. Optionally the flock stops there for `stopMinutes`. This replaces the
 * old per-participant rest stop: stops are now shared, like the route.
 */
export interface FlockWaypoint {
  id: string;
  location: LatLng;
  address: string;
  name: string; // user label, falls back to address
  stopMinutes: number; // 0 = pass through, >0 = everyone stops
  // True when the name was AUTO-derived (a placeholder, a reverse-geocoded label, an
  // imported shape point) — so moving the pin refreshes it to the new place. False
  // once the user names it themselves (we never clobber that). Undefined on legacy
  // data → callers fall back to the name heuristic (see waypointNameIsAuto).
  autoNamed?: boolean;
  // GPX round-trip: verbatim XML children of the source <rtept> we didn't model
  // (elevation, time, foreign extensions, …), re-emitted on export. Undefined
  // for waypoints created in-app.
  gpxExtra?: string;
}

export interface Participant {
  id: string;
  name: string;
  color: string; // assigned from palette, used on map
  addedAt: string; // ISO timestamp

  // Hard constraints — ALL optional. "No preference" everywhere = a full participant the
  // engine joins to the flock wherever it maximises together-time. The objective is
  // together-time alone; there is no distance TARGET (only a cap) and no pace floor.
  startPin: LocationPin; // where they join — default { kind: "auto" }
  finishPin: LocationPin; // where they leave — default { kind: "auto" }
  maxDistanceKm: number | null; // "how far can you run" — hard cap; null = no cap
  pace: number | null; // "how fast can you run" — sec/km; null = a sensible default
  earliestStartTime: string | null; // optional "I can't start before…" ("06:00")
  latestFinishTime: string | null; // optional "I must be done by…" ("11:00")
}

export interface ScheduleSegment {
  type: "run" | "rest";
  startTime: string;
  endTime: string;
  startLocation: LatLng;
  endLocation: LatLng;
  paceSecPerKm: number | null; // null for rest
  companionIds: string[]; // who else is running this segment simultaneously
  distanceKm: number; // 0 for rest — convenience for the schedule view
  label?: string; // for rest segments: the waypoint/stop name
}

export interface ComputedRoute {
  participantId: string;
  waypoints: LatLng[]; // ordered: start, rest stop if any, finish
  geometry: GeoJSON.LineString; // snapped to actual paths via ORS
  distanceKm: number;
  estimatedDurationMinutes: number;
  departureTime: string; // "06:00"
  arrivalTime: string; // "09:23"
  schedule: ScheduleSegment[];
}

export interface SharedSegment {
  participantIds: string[]; // who shares this segment
  geometry: GeoJSON.LineString;
  overlapMinutes: number; // time all are on this segment together
  startTime: string; // earliest participant's time at start of segment
  // True only where the flock genuinely grows here — someone joins (or a feeder
  // convergence). Drives the "meet here" diamond, so peel-off boundaries (the set
  // only shrinks) don't get mislabelled as meetings. Optional: absent on sessions
  // computed before this field existed → the map treats absence as "show" (the
  // prior behaviour) until the next recalc.
  isConvergence?: boolean;
}

// The three editable sections of a plan. Locks are an ADVISORY signal among a
// trusted group — anyone can flip any lock, and anyone can edit anything that's
// unlocked (the shared URL is the real access boundary). Per-section here; a
// per-runner layer (runnerLocks) sits under the "runners" section.
export type LockSection = "run" | "route" | "runners";
export type SectionLocks = Record<LockSection, boolean>;

export interface FlockSession {
  id: string; // 6-char nanoid, e.g. "abc123"
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp — used for polling change detection
  // Advisory section locks (default all false = open). "Lock the plan" sets all
  // three; "Unlock" clears them. Per-runner locks are an INDEPENDENT layer the
  // global toggle never touches, so a self-locked runner survives a lock/unlock.
  locks: SectionLocks;
  runnerLocks: Record<string, boolean>; // participantId → locked (within the runners section)
  unitPreference: Unit; // set by first participant, shown to all
  // Run-level config (defaults, never mandatory). The flock's departure anchor and its
  // intended distance; per-runner constraints are optional overrides.
  startAnchor: TimeAnchor; // default { kind: "auto" } → logic-driven (07:00 unless constraints move it)
  intendedDistanceKm: number | null; // set, or null → waypoint-tour length / 10 km
  participants: Participant[];
  waypoints: FlockWaypoint[]; // shared waypoints everyone routes through
  computedRoutes: ComputedRoute[] | null; // null until first calculation
  sharedSegments: SharedSegment[] | null;
  flockRoute: GeoJSON.LineString | null; // the shared backbone spine, for the map
  waypointEtas: Record<string, string> | null; // waypointId → "HH:MM" the flock passes
  // GPX round-trip: verbatim top-level elements from an imported GPX that we
  // didn't consume (foreign metadata, extra tracks/routes, POI waypoints, gpx
  // extensions), re-emitted on export so nothing is lost. Null when never imported.
  gpxPassthrough: string | null;
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export interface CreateFlockResponse {
  id: string;
  url: string;
}

export interface GeocodeResult {
  displayName: string;
  shortName: string;
  lat: number;
  lng: number;
}

// Result of naming a tapped point. `name` is a nearby named POI when one sits
// within range of the tap; `address` is the nearest street/place label. The
// client labels a dropped pin with name ?? address (?? "Dropped pin").
export interface ReverseGeocodeResult {
  name: string | null;
  address: string | null;
}

// Action-based PATCH body. Doing the mutation server-side (read → apply → write)
// keeps last-write-wins clobbering to a minimum and makes every change loggable.
export type PatchAction =
  | { action: "setUnit"; unitPreference: Unit }
  | { action: "setRunConfig"; startAnchor?: TimeAnchor; intendedDistanceKm?: number | null }
  // Participants carry no ownership — anyone may add/edit/remove one that isn't locked
  // (gated by the runners section lock + that runner's lock, server-side).
  | { action: "addParticipant"; participant: NewParticipantInput }
  | {
      action: "updateParticipant";
      participantId: string;
      updates: Partial<ParticipantConstraints>;
    }
  | { action: "removeParticipant"; participantId: string }
  | {
      action: "setRoutes";
      computedRoutes: ComputedRoute[];
      sharedSegments: SharedSegment[];
      flockRoute: GeoJSON.LineString | null;
      waypointEtas: Record<string, string> | null;
      // The session.updatedAt these routes were computed from. If the plan has
      // changed since (a waypoint/participant edit landed during the calc), the
      // routes are stale and must NOT overwrite the newer plan — they'd silently
      // "ignore" the edit. Optional for back-compat; when set, persistence is
      // conditional on it still matching.
      expectedUpdatedAt?: string;
    }
  // Shared waypoints are universal — anyone can manage them (no edit token).
  // `index` (optional) splices the waypoint into the ordered list at that position
  // — used when dragging a new point out of the route so it lands between the right
  // neighbours; omitted (the default) appends.
  | { action: "addWaypoint"; waypoint: Omit<FlockWaypoint, "id">; index?: number }
  | { action: "updateWaypoint"; waypointId: string; updates: Partial<Omit<FlockWaypoint, "id">> }
  | { action: "removeWaypoint"; waypointId: string }
  | { action: "reorderWaypoints"; waypointIds: string[] }
  | {
      // Cosmetic bulk rename by waypoint id. Names don't affect routing, so this
      // does NOT invalidate the computed route — it's how background reverse-naming
      // (after a GPX import) fills in real names without a recalc per waypoint.
      action: "renameWaypoints";
      names: Record<string, { name: string; address: string }>;
    }
  // Replace the whole route from an imported GPX (server assigns waypoint ids).
  | {
      action: "importRoute";
      waypoints: Omit<FlockWaypoint, "id">[];
      gpxPassthrough: string | null;
    }
  // "Lock the plan" / "Unlock to make changes" — set/clear ALL three section locks
  // (runnerLocks untouched). Anyone may do this.
  | { action: "lock" }
  | { action: "unlock" }
  // Granular advisory toggles — anyone may flip these.
  | { action: "setSectionLock"; section: LockSection; locked: boolean }
  | { action: "setRunnerLock"; participantId: string; locked: boolean };

// The constraint subset a client may set/update on a participant. Server owns
// id / color / addedAt.
export type ParticipantConstraints = Omit<Participant, "id" | "color" | "addedAt">;

export interface NewParticipantInput extends ParticipantConstraints {
  // Optional client-suggested id; server generates one if absent.
  id?: string;
}
