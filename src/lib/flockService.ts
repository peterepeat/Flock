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
import { isAutoWaypointName } from "./flockGpx";
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
    startAnchor: { kind: "auto" },
    intendedDistanceKm: null,
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
  if (session) normalizeSession(session);
  return session;
}

/**
 * Migrate a stored session to the social-first model in place: fill run-level defaults and
 * convert any legacy participant (startLocation/preferredDistance/maxDistance/preferredPace)
 * to the pin model — an old home becomes a manual start pin, an old finish a manual finish
 * pin, the old hard cap becomes maxDistanceKm. Idempotent; a no-op for new sessions.
 */
function normalizeSession(session: FlockSession): void {
  if (!session.waypoints) session.waypoints = [];
  if (!session.startAnchor) session.startAnchor = { kind: "auto" };
  if (session.intendedDistanceKm === undefined) session.intendedDistanceKm = null;
  for (const p of session.participants) {
    const legacy = p as unknown as Record<string, unknown>;
    if (!p.startPin) {
      const sl = legacy.startLocation;
      p.startPin = isValidLatLng(sl)
        ? { kind: "manual", location: sl, address: (legacy.startAddress as string) ?? "" }
        : { kind: "auto" };
    }
    if (!p.finishPin) {
      const fl = legacy.finishLocation;
      p.finishPin = isValidLatLng(fl)
        ? { kind: "manual", location: fl, address: (legacy.finishAddress as string) ?? "" }
        : { kind: "auto" };
    }
    if (p.maxDistanceKm === undefined) p.maxDistanceKm = (legacy.maxDistance as number) ?? null;
    if (p.pace === undefined) p.pace = (legacy.preferredPace as number) ?? null;
    if (p.earliestStartTime === undefined) p.earliestStartTime = (legacy.earliestStartTime as string) ?? null;
    if (p.latestFinishTime === undefined) p.latestFinishTime = (legacy.latestFinishTime as string) ?? null;
  }
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
    action.action === "setRunConfig" ||
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

    case "setRunConfig": {
      if (action.startAnchor !== undefined) session.startAnchor = action.startAnchor;
      if (action.intendedDistanceKm !== undefined) session.intendedDistanceKm = action.intendedDistanceKm;
      clearComputed(session);
      log.info("run config set", { id, anchor: session.startAnchor.kind, distance: session.intendedDistanceKm });
      break;
    }

    case "addParticipant": {
      const p = action.participant;
      if (!p?.name?.trim()) return { ok: false, status: 400, error: "Name is required" };

      const pid = p.id || newParticipantId();
      if (session.participants.some((x) => x.id === pid)) {
        return { ok: false, status: 409, error: "Participant id already exists" };
      }

      const participant: Participant = {
        id: pid,
        name: p.name.trim(),
        color: nextColor(session.participants.map((x) => x.color)),
        addedAt: now(),
        startPin: p.startPin ?? { kind: "auto" },
        finishPin: p.finishPin ?? { kind: "auto" },
        maxDistanceKm: p.maxDistanceKm ?? null,
        pace: p.pace ?? null,
        earliestStartTime: p.earliestStartTime ?? null,
        latestFinishTime: p.latestFinishTime ?? null,
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
        startPin: u.startPin !== undefined ? u.startPin : current.startPin,
        finishPin: u.finishPin !== undefined ? u.finishPin : current.finishPin,
        maxDistanceKm: u.maxDistanceKm !== undefined ? u.maxDistanceKm : current.maxDistanceKm,
        pace: u.pace !== undefined ? u.pace : current.pace,
        earliestStartTime: u.earliestStartTime !== undefined ? u.earliestStartTime : current.earliestStartTime,
        latestFinishTime: u.latestFinishTime !== undefined ? u.latestFinishTime : current.latestFinishTime,
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
      // Splice at `index` (clamped) when given — a drag pulled a new point out of
      // the route and it must land between the right neighbours so the corridor stays
      // ordered; otherwise append.
      if (action.index != null) {
        const at = Math.max(0, Math.min(Math.floor(action.index), session.waypoints.length));
        session.waypoints.splice(at, 0, waypoint);
      } else {
        session.waypoints.push(waypoint);
      }
      clearComputed(session);
      log.info("waypoint added", { id, waypointId: waypoint.id, index: action.index ?? null, stopMinutes: waypoint.stopMinutes });
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
      // A pin to the deleted waypoint reverts to "no preference" (NOT decoupled to its
      // last location) — the runner just rejoins wherever it's best. The time anchor too.
      for (const p of session.participants) {
        if (p.startPin.kind === "waypoint" && p.startPin.waypointId === action.waypointId) p.startPin = { kind: "auto" };
        if (p.finishPin.kind === "waypoint" && p.finishPin.waypointId === action.waypointId) p.finishPin = { kind: "auto" };
      }
      if (session.startAnchor.kind === "waypoint" && session.startAnchor.waypointId === action.waypointId) {
        session.startAnchor = { kind: "auto" };
      }
      clearComputed(session);
      log.info("waypoint removed", { id, waypointId: action.waypointId });
      break;
    }

    case "reorderWaypoints": {
      // Reorder by the given id list; any waypoint not named keeps its relative
      // order, appended after (defensive against a stale client list). Pins travel WITH
      // their waypoint (they reference it by id), so no decoupling.
      const byId = new Map(session.waypoints.map((w) => [w.id, w]));
      const named = action.waypointIds
        .map((wid) => byId.get(wid))
        .filter((w): w is FlockWaypoint => w != null);
      const rest = session.waypoints.filter((w) => !action.waypointIds.includes(w.id));
      session.waypoints = [...named, ...rest];
      // Keep the dropdown invariant: a finish pinned BEFORE the start (after reorder)
      // reverts to "no preference".
      const order = new Map(session.waypoints.map((w, i) => [w.id, i]));
      for (const p of session.participants) {
        if (p.startPin.kind === "waypoint" && p.finishPin.kind === "waypoint") {
          const si = order.get(p.startPin.waypointId);
          const fi = order.get(p.finishPin.waypointId);
          if (si != null && fi != null && fi <= si) p.finishPin = { kind: "auto" };
        }
      }
      clearComputed(session);
      log.info("waypoints reordered", { id, order: session.waypoints.map((w) => w.id.slice(0, 4)) });
      break;
    }

    case "renameWaypoints": {
      // Cosmetic only: set names/addresses by id. Deliberately does NOT call
      // clearComputed — a name doesn't change routing, so the computed route stays
      // valid and background reverse-naming after an import won't trigger a recalc
      // per waypoint. Unknown ids are ignored; save() still bumps updatedAt so
      // clients pick up the names. Allowed regardless of lock (purely cosmetic).
      let renamed = 0;
      for (const w of session.waypoints) {
        const n = action.names[w.id];
        const name = n?.name?.trim();
        if (!name) continue;
        // Only fill in names that are STILL auto-generated placeholders. This is
        // the authoritative guard against background naming clobbering a name the
        // user (or another device) set while we were geocoding — checked here at
        // write time, so it's immune to client-side staleness.
        if (!isAutoWaypointName(w.name)) continue;
        w.name = name;
        w.address = n.address?.trim() || name;
        renamed++;
      }
      log.info("waypoints renamed", { id, renamed });
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
