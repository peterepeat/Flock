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
}

function now(): string {
  return new Date().toISOString();
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
    action.action === "removeWaypoint";

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
      session.computedRoutes = null;
      session.sharedSegments = null;
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
      session.computedRoutes = null;
      session.sharedSegments = null;
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
      session.computedRoutes = null;
      session.sharedSegments = null;
      log.info("participant removed", { id, participantId: action.participantId });
      break;
    }

    case "setRoutes": {
      session.computedRoutes = action.computedRoutes;
      session.sharedSegments = action.sharedSegments;
      log.info("routes updated", {
        id,
        routes: action.computedRoutes.length,
        shared: action.sharedSegments.length,
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
      };
      session.waypoints.push(waypoint);
      session.computedRoutes = null;
      session.sharedSegments = null;
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
      session.computedRoutes = null;
      session.sharedSegments = null;
      log.info("waypoint updated", { id, waypointId: action.waypointId });
      break;
    }

    case "removeWaypoint": {
      const exists = session.waypoints.some((w) => w.id === action.waypointId);
      if (!exists) return { ok: false, status: 404, error: "Waypoint not found" };
      session.waypoints = session.waypoints.filter((w) => w.id !== action.waypointId);
      session.computedRoutes = null;
      session.sharedSegments = null;
      log.info("waypoint removed", { id, waypointId: action.waypointId });
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
