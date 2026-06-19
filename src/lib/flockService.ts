// ---------------------------------------------------------------------------
// Flock service — the single place that creates and mutates a flock session.
//
// All mutations run server-side as read → apply action → write, which keeps
// last-write-wins clobbering to a minimum and gives one well-logged choke point.
// Every successful write bumps updatedAt (the polling heartbeat) and resets TTL
// (handled by store.saveFlock).
// ---------------------------------------------------------------------------

import { createLogger } from "./logger";
import { nextColor } from "./colors";
import { newFlockId, newParticipantId, newWaypointId } from "./ids";
import { getStore, hashToken } from "./store";
import type {
  FlockSession,
  FlockWaypoint,
  Participant,
  PatchAction,
  Unit,
} from "./types";

const log = createLogger("flock-service");

export interface ApplyResult {
  ok: boolean;
  status: number;
  session?: FlockSession;
  error?: string;
  // For addParticipant: the id the server actually used.
  participantId?: string;
  // For setRoutes: the routes were discarded because the plan changed under us
  // (expectedUpdatedAt no longer matched). The caller should recompute.
  stale?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

/** Any change to people/waypoints invalidates the computed plan. */
function clearComputed(session: FlockSession): void {
  session.computedRoutes = null;
  session.sharedSegments = null;
  session.flockRoute = null;
  session.waypointEtas = null;
}

export async function createFlock(unitPreference: Unit = "km"): Promise<FlockSession> {
  const store = getStore();
  const ts = now();
  const session: FlockSession = {
    id: newFlockId(),
    createdAt: ts,
    updatedAt: ts,
    lockedAt: null,
    unitPreference,
    participants: [],
    waypoints: [],
    computedRoutes: null,
    sharedSegments: null,
    flockRoute: null,
    waypointEtas: null,
    gpxPassthrough: null,
  };
  await store.createFlock(session);
  log.info("flock created", { id: session.id, unit: unitPreference, backend: store.backend });
  return session;
}

export async function getFlock(id: string): Promise<FlockSession | null> {
  const session = await getStore().getFlock(id);
  // Normalise sessions created before shared waypoints existed.
  if (session && !session.waypoints) session.waypoints = [];
  return session;
}

function isValidLatLng(v: unknown): v is { lat: number; lng: number } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { lat: unknown }).lat === "number" &&
    typeof (v as { lng: unknown }).lng === "number"
  );
}

export async function applyPatch(id: string, action: PatchAction): Promise<ApplyResult> {
  const store = getStore();
  const session = await store.getFlock(id);
  if (!session) {
    log.warn("patch on missing flock", { id, action: action.action });
    return { ok: false, status: 404, error: "Flock not found" };
  }
  if (!session.waypoints) session.waypoints = [];

  const locked = session.lockedAt != null;
  const mutatesPlan =
    action.action === "addParticipant" ||
    action.action === "updateParticipant" ||
    action.action === "removeParticipant" ||
    action.action === "setUnit" ||
    action.action === "addWaypoint" ||
    action.action === "updateWaypoint" ||
    action.action === "removeWaypoint" ||
    action.action === "reorderWaypoints" ||
    action.action === "importRoute";

  if (locked && mutatesPlan) {
    log.info("rejected mutation on locked flock", { id, action: action.action });
    return { ok: false, status: 409, error: "The plan is locked." };
  }

  log.debug("applying action", { id, action: action.action });

  switch (action.action) {
    case "setUnit": {
      session.unitPreference = action.unitPreference;
      break;
    }

    case "addParticipant": {
      const p = action.participant;
      if (!p?.name?.trim()) return { ok: false, status: 400, error: "Name is required" };
      if (!isValidLatLng(p.startLocation))
        return { ok: false, status: 400, error: "A start location is required" };

      const pid = p.id || newParticipantId();
      if (session.participants.some((x) => x.id === pid)) {
        return { ok: false, status: 409, error: "Participant id already exists" };
      }

      const participant: Participant = {
        id: pid,
        name: p.name.trim(),
        color: nextColor(session.participants.map((x) => x.color)),
        addedAt: now(),
        startLocation: p.startLocation,
        startAddress: p.startAddress ?? "",
        earliestStartTime: p.earliestStartTime ?? null,
        finishLocation: p.finishLocation ?? null,
        finishAddress: p.finishAddress ?? null,
        latestFinishTime: p.latestFinishTime ?? null,
        preferredPace: p.preferredPace ?? null,
        maxPace: p.maxPace ?? null,
        preferredDistance: p.preferredDistance ?? null,
        maxDistance: p.maxDistance ?? null,
        restStop: p.restStop ?? null,
      };

      session.participants.push(participant);
      await store.setTokenHash(id, pid, hashToken(action.editToken));
      // Routes are now stale.
      clearComputed(session);
      log.info("participant added", {
        id,
        participantId: pid,
        name: participant.name,
        color: participant.color,
        count: session.participants.length,
      });

      await save(session);
      return { ok: true, status: 200, session, participantId: pid };
    }

    case "updateParticipant": {
      const idx = session.participants.findIndex((x) => x.id === action.participantId);
      if (idx === -1) return { ok: false, status: 404, error: "Participant not found" };

      const verified = await verifyToken(id, action.participantId, action.editToken);
      if (!verified.ok) return verified;

      const current = session.participants[idx];
      const u = action.updates;
      // Only allow constraint fields; never let the client overwrite id/color/addedAt.
      session.participants[idx] = {
        ...current,
        name: u.name?.trim() || current.name,
        startLocation: isValidLatLng(u.startLocation) ? u.startLocation : current.startLocation,
        startAddress: u.startAddress ?? current.startAddress,
        earliestStartTime: u.earliestStartTime !== undefined ? u.earliestStartTime : current.earliestStartTime,
        finishLocation: u.finishLocation !== undefined ? u.finishLocation : current.finishLocation,
        finishAddress: u.finishAddress !== undefined ? u.finishAddress : current.finishAddress,
        latestFinishTime: u.latestFinishTime !== undefined ? u.latestFinishTime : current.latestFinishTime,
        preferredPace: u.preferredPace !== undefined ? u.preferredPace : current.preferredPace,
        maxPace: u.maxPace !== undefined ? u.maxPace : current.maxPace,
        preferredDistance: u.preferredDistance !== undefined ? u.preferredDistance : current.preferredDistance,
        maxDistance: u.maxDistance !== undefined ? u.maxDistance : current.maxDistance,
        restStop: u.restStop !== undefined ? u.restStop : current.restStop,
      };
      clearComputed(session);
      log.info("participant updated", { id, participantId: action.participantId });
      break;
    }

    case "removeParticipant": {
      const exists = session.participants.some((x) => x.id === action.participantId);
      if (!exists) return { ok: false, status: 404, error: "Participant not found" };

      const verified = await verifyToken(id, action.participantId, action.editToken);
      if (!verified.ok) return verified;

      session.participants = session.participants.filter((x) => x.id !== action.participantId);
      await store.deleteTokenHash(id, action.participantId);
      clearComputed(session);
      log.info("participant removed", { id, participantId: action.participantId });
      break;
    }

    case "setRoutes": {
      // Freshness guard: if the plan changed since these routes were computed
      // (a waypoint/participant edit landed during the calc), discard them — a
      // stale write would silently "ignore" the edit. Don't save: the session
      // stays computed-null so the calc retries against the current plan.
      if (action.expectedUpdatedAt && session.updatedAt !== action.expectedUpdatedAt) {
        log.info("setRoutes stale — plan changed during calc, discarding", {
          id,
          computedFrom: action.expectedUpdatedAt,
          current: session.updatedAt,
        });
        return { ok: true, status: 200, session, stale: true };
      }
      session.computedRoutes = action.computedRoutes;
      session.sharedSegments = action.sharedSegments;
      session.flockRoute = action.flockRoute;
      session.waypointEtas = action.waypointEtas;
      log.info("routes updated", {
        id,
        routes: action.computedRoutes.length,
        shared: action.sharedSegments.length,
        flockRoute: action.flockRoute ? action.flockRoute.coordinates.length : 0,
        etas: action.waypointEtas ? Object.keys(action.waypointEtas).length : 0,
      });
      break;
    }

    case "addWaypoint": {
      const w = action.waypoint;
      if (!isValidLatLng(w?.location))
        return { ok: false, status: 400, error: "A waypoint location is required" };
      const waypoint: FlockWaypoint = {
        id: newWaypointId(),
        location: w.location,
        address: w.address ?? "",
        name: w.name?.trim() || w.address || "Waypoint",
        stopMinutes: Math.max(0, w.stopMinutes ?? 0),
        // Preserve foreign GPX data so re-adding (e.g. an undo of a remove) keeps
        // the lossless round-trip — mirrors the importRoute handler.
        ...(w.gpxExtra ? { gpxExtra: w.gpxExtra } : {}),
      };
      session.waypoints.push(waypoint);
      clearComputed(session);
      log.info("waypoint added", { id, waypointId: waypoint.id, stopMinutes: waypoint.stopMinutes });
      break;
    }

    case "updateWaypoint": {
      const idx = session.waypoints.findIndex((w) => w.id === action.waypointId);
      if (idx === -1) return { ok: false, status: 404, error: "Waypoint not found" };
      const cur = session.waypoints[idx];
      const u = action.updates;
      session.waypoints[idx] = {
        ...cur,
        location: isValidLatLng(u.location) ? u.location : cur.location,
        address: u.address ?? cur.address,
        name: u.name?.trim() || cur.name,
        stopMinutes: u.stopMinutes != null ? Math.max(0, u.stopMinutes) : cur.stopMinutes,
      };
      clearComputed(session);
      log.info("waypoint updated", { id, waypointId: action.waypointId });
      break;
    }

    case "removeWaypoint": {
      const exists = session.waypoints.some((w) => w.id === action.waypointId);
      if (!exists) return { ok: false, status: 404, error: "Waypoint not found" };
      session.waypoints = session.waypoints.filter((w) => w.id !== action.waypointId);
      clearComputed(session);
      log.info("waypoint removed", { id, waypointId: action.waypointId });
      break;
    }

    case "reorderWaypoints": {
      // Reorder by the given id list; any waypoint not named keeps its relative
      // order, appended after (defensive against a stale client list).
      const byId = new Map(session.waypoints.map((w) => [w.id, w]));
      const named = action.waypointIds
        .map((wid) => byId.get(wid))
        .filter((w): w is FlockWaypoint => w != null);
      const rest = session.waypoints.filter((w) => !action.waypointIds.includes(w.id));
      session.waypoints = [...named, ...rest];
      clearComputed(session);
      log.info("waypoints reordered", { id, order: session.waypoints.map((w) => w.id.slice(0, 4)) });
      break;
    }

    case "importRoute": {
      // Replace the whole route from an imported GPX. Server assigns fresh ids;
      // per-waypoint gpxExtra + doc-level gpxPassthrough carry foreign data
      // through unchanged for lossless re-export.
      const imported: FlockWaypoint[] = (action.waypoints ?? [])
        .filter((w) => isValidLatLng(w?.location))
        .map((w) => ({
          id: newWaypointId(),
          location: w.location,
          address: w.address ?? "",
          name: w.name?.trim() || w.address || "Waypoint",
          stopMinutes: Math.max(0, w.stopMinutes ?? 0),
          ...(w.gpxExtra ? { gpxExtra: w.gpxExtra } : {}),
        }));
      if (imported.length === 0)
        return { ok: false, status: 400, error: "That GPX had no usable route points." };
      session.waypoints = imported;
      session.gpxPassthrough = action.gpxPassthrough ?? null;
      clearComputed(session);
      log.info("route imported", {
        id,
        waypoints: imported.length,
        stops: imported.filter((w) => w.stopMinutes > 0).length,
        passthroughBytes: action.gpxPassthrough?.length ?? 0,
      });
      break;
    }

    case "lock": {
      session.lockedAt = now();
      log.info("flock locked", { id });
      break;
    }

    case "unlock": {
      session.lockedAt = null;
      log.info("flock unlocked", { id });
      break;
    }

    default: {
      const _exhaustive: never = action;
      return { ok: false, status: 400, error: `Unknown action: ${JSON.stringify(_exhaustive)}` };
    }
  }

  await save(session);
  return { ok: true, status: 200, session };
}

async function verifyToken(
  flockId: string,
  participantId: string,
  token: string,
): Promise<ApplyResult> {
  const stored = await getStore().getTokenHash(flockId, participantId);
  if (!stored) {
    // No token on record — allow (legacy/edge), but log it loudly.
    log.warn("no edit token on record; allowing edit", { flockId, participantId });
    return { ok: true, status: 200 };
  }
  if (!token || hashToken(token) !== stored) {
    log.info("edit token mismatch — rejecting", { flockId, participantId });
    return { ok: false, status: 403, error: "You can only edit the entry you created." };
  }
  return { ok: true, status: 200 };
}

async function save(session: FlockSession): Promise<void> {
  session.updatedAt = now();
  await getStore().saveFlock(session);
}
