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

export interface RestStopPreference {
  wantsStop: boolean;
  durationMinutes: number; // default 30
  location: LatLng | null; // null = "anywhere that works"
  locationAddress: string | null;
}

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

  // Constraints — all optional except start location.
  startLocation: LatLng;
  startAddress: string;
  earliestStartTime: string | null; // "06:00" local time

  finishLocation: LatLng | null; // null = return to start
  finishAddress: string | null;
  latestFinishTime: string | null; // "11:00" local time

  preferredPace: number | null; // sec/km
  maxPace: number | null; // faster end — must be ≤ preferredPace sec/km

  preferredDistance: number | null; // km
  maxDistance: number | null; // hard cap, km

  restStop: RestStopPreference | null;
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

export interface FlockSession {
  id: string; // 6-char nanoid, e.g. "abc123"
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp — used for polling change detection
  lockedAt: string | null; // set when group locks the plan
  unitPreference: Unit; // set by first participant, shown to all
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
  | { action: "addParticipant"; participant: NewParticipantInput; editToken: string }
  | {
      action: "updateParticipant";
      participantId: string;
      updates: Partial<ParticipantConstraints>;
      editToken: string;
    }
  | { action: "removeParticipant"; participantId: string; editToken: string }
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
  | { action: "addWaypoint"; waypoint: Omit<FlockWaypoint, "id"> }
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
  | { action: "lock" }
  | { action: "unlock" };

// The constraint subset a client may set/update on a participant. Server owns
// id / color / addedAt.
export type ParticipantConstraints = Omit<Participant, "id" | "color" | "addedAt">;

export interface NewParticipantInput extends ParticipantConstraints {
  // Optional client-suggested id; server generates one if absent.
  id?: string;
}
