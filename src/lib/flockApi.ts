// ---------------------------------------------------------------------------
// Client-side wrappers around PATCH /api/flocks/[id]. Each returns the updated
// session so the caller can force-sync the store immediately (no waiting for the
// next poll). Edit-token plumbing lives here so callers don't have to think
// about it.
// ---------------------------------------------------------------------------

import { createLogger } from "./logger";
import { createToken, getToken } from "./editTokens";
import { newParticipantId } from "./ids";
import type {
  FlockSession,
  FlockWaypoint,
  ParticipantConstraints,
  PatchAction,
  TimeAnchor,
  Unit,
} from "./types";

const log = createLogger("flock-api");

export class FlockApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "FlockApiError";
  }
}

async function patch(
  flockId: string,
  action: PatchAction,
): Promise<{ session: FlockSession; participantId?: string }> {
  log.debug("patch", { flockId, action: action.action });
  const res = await fetch(`/api/flocks/${flockId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.warn("patch rejected", { flockId, action: action.action, status: res.status, error: data?.error });
    throw new FlockApiError(data?.error || "Request failed", res.status);
  }
  return data as { session: FlockSession; participantId?: string };
}

export async function setUnit(flockId: string, unitPreference: Unit): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "setUnit", unitPreference });
  return session;
}

/** Run-level config: the flock's departure anchor and/or its intended distance. */
export async function setRunConfig(
  flockId: string,
  config: { startAnchor?: TimeAnchor; intendedDistanceKm?: number | null },
): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "setRunConfig", ...config });
  return session;
}

export async function addParticipant(
  flockId: string,
  constraints: ParticipantConstraints,
): Promise<{ session: FlockSession; participantId: string }> {
  // Generate the id + token up front so localStorage and the server agree.
  const participantId = newParticipantId();
  const editToken = createToken(flockId, participantId);
  const { session } = await patch(flockId, {
    action: "addParticipant",
    participant: { ...constraints, id: participantId },
    editToken,
  });
  log.info("participant added", { flockId, participantId });
  return { session, participantId };
}

export async function updateParticipant(
  flockId: string,
  participantId: string,
  updates: Partial<ParticipantConstraints>,
): Promise<FlockSession> {
  const editToken = getToken(flockId, participantId);
  if (!editToken) {
    throw new FlockApiError("You can only edit the entry you created on this device.", 403);
  }
  const { session } = await patch(flockId, {
    action: "updateParticipant",
    participantId,
    updates,
    editToken,
  });
  return session;
}

export async function removeParticipant(
  flockId: string,
  participantId: string,
): Promise<FlockSession> {
  const editToken = getToken(flockId, participantId) || "";
  const { session } = await patch(flockId, {
    action: "removeParticipant",
    participantId,
    editToken,
  });
  return session;
}

export async function addWaypoint(
  flockId: string,
  waypoint: Omit<FlockWaypoint, "id">,
  index?: number,
): Promise<FlockSession> {
  const { session } = await patch(flockId, {
    action: "addWaypoint",
    waypoint,
    ...(index != null ? { index } : {}),
  });
  return session;
}

export async function updateWaypoint(
  flockId: string,
  waypointId: string,
  updates: Partial<Omit<FlockWaypoint, "id">>,
): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "updateWaypoint", waypointId, updates });
  return session;
}

export async function removeWaypoint(flockId: string, waypointId: string): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "removeWaypoint", waypointId });
  return session;
}

export async function reorderWaypoints(
  flockId: string,
  waypointIds: string[],
): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "reorderWaypoints", waypointIds });
  return session;
}

export async function importRoute(
  flockId: string,
  waypoints: Omit<FlockWaypoint, "id">[],
  gpxPassthrough: string | null,
): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "importRoute", waypoints, gpxPassthrough });
  return session;
}

/** Cosmetic bulk rename by id (does NOT recompute the route). */
export async function renameWaypoints(
  flockId: string,
  names: Record<string, { name: string; address: string }>,
): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "renameWaypoints", names });
  return session;
}

export async function lockFlock(flockId: string): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "lock" });
  return session;
}

export async function unlockFlock(flockId: string): Promise<FlockSession> {
  const { session } = await patch(flockId, { action: "unlock" });
  return session;
}
