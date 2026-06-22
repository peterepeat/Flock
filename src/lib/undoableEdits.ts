// ---------------------------------------------------------------------------
// Undoable local edits.
//
// Thin wrappers around the flockApi mutations that ALSO record an inverse on the
// per-device history stack (flockStore). They capture the pre-state from the
// current session, perform the edit, apply the result, and push {undo, redo}
// thunks built from existing PatchActions — so undo is just a compensating
// mutation that propagates to everyone via normal sync. No server changes.
//
// Components call these instead of the raw flockApi fn + applyServerSession.
// ---------------------------------------------------------------------------

import {
  addWaypoint,
  importRoute,
  removeWaypoint,
  reorderWaypoints,
  setUnit,
  updateParticipant,
  updateWaypoint,
} from "./flockApi";
import { useFlockStore } from "@/store/flockStore";
import type {
  FlockSession,
  FlockWaypoint,
  ParticipantConstraints,
  Unit,
} from "./types";

type WaypointInput = Omit<FlockWaypoint, "id">;
type WaypointUpdates = Partial<WaypointInput>;

const store = () => useFlockStore.getState();
const apply = (s: FlockSession) => store().applyServerSession(s, true);

/** The new-waypoint id from a session where addWaypoint just appended one. */
const appendedId = (s: FlockSession): string | undefined =>
  s.waypoints[s.waypoints.length - 1]?.id;

/** A waypoint as an add/import input (carries gpxExtra through for fidelity). */
const toInput = (w: FlockWaypoint): WaypointInput => ({
  location: w.location,
  address: w.address,
  name: w.name,
  stopMinutes: w.stopMinutes,
  ...(w.gpxExtra ? { gpxExtra: w.gpxExtra } : {}),
});

const fullConstraints = (p: ParticipantConstraints): ParticipantConstraints => ({
  name: p.name,
  startPin: p.startPin,
  finishPin: p.finishPin,
  maxDistanceKm: p.maxDistanceKm,
  pace: p.pace,
  earliestStartTime: p.earliestStartTime,
  latestFinishTime: p.latestFinishTime,
});

export async function uAddWaypoint(flockId: string, data: WaypointInput): Promise<FlockSession> {
  const s = await addWaypoint(flockId, data);
  apply(s);
  let id = appendedId(s);
  if (id) {
    store().recordHistory({
      label: "Add waypoint",
      undo: () => removeWaypoint(flockId, id!),
      redo: async () => {
        const r = await addWaypoint(flockId, data);
        id = appendedId(r);
        return r;
      },
    });
  }
  return s;
}

export async function uUpdateWaypoint(
  flockId: string,
  id: string,
  updates: WaypointUpdates,
): Promise<FlockSession> {
  const before = store().session?.waypoints.find((w) => w.id === id);
  const s = await updateWaypoint(flockId, id, updates);
  apply(s);
  if (before) {
    const prior: WaypointUpdates = {
      name: before.name,
      address: before.address,
      location: before.location,
      stopMinutes: before.stopMinutes,
    };
    store().recordHistory({
      label: "Edit waypoint",
      undo: () => updateWaypoint(flockId, id, prior),
      redo: () => updateWaypoint(flockId, id, updates),
    });
  }
  return s;
}

export async function uRemoveWaypoint(flockId: string, id: string): Promise<FlockSession> {
  const wps = store().session?.waypoints ?? [];
  const before = wps.find((w) => w.id === id);
  const index = wps.findIndex((w) => w.id === id);
  const s = await removeWaypoint(flockId, id);
  apply(s);
  if (before) {
    const data = toInput(before);
    let curId = id;
    store().recordHistory({
      label: "Remove waypoint",
      undo: async () => {
        // Re-add (server appends with a fresh id) then slot it back to its place.
        let r = await addWaypoint(flockId, data);
        const newId = appendedId(r);
        if (newId && index >= 0) {
          const ids = r.waypoints.map((w) => w.id);
          ids.splice(ids.indexOf(newId), 1);
          ids.splice(Math.min(index, ids.length), 0, newId);
          r = await reorderWaypoints(flockId, ids);
        }
        if (newId) curId = newId;
        return r;
      },
      redo: () => removeWaypoint(flockId, curId),
    });
  }
  return s;
}

export async function uReorderWaypoints(flockId: string, ids: string[]): Promise<FlockSession> {
  const priorOrder = (store().session?.waypoints ?? []).map((w) => w.id);
  const s = await reorderWaypoints(flockId, ids);
  apply(s);
  store().recordHistory({
    label: "Reorder waypoints",
    undo: () => reorderWaypoints(flockId, priorOrder),
    redo: () => reorderWaypoints(flockId, ids),
  });
  return s;
}

export async function uImportRoute(
  flockId: string,
  waypoints: WaypointInput[],
  passthrough: string | null,
): Promise<FlockSession> {
  const sess = store().session;
  const priorWps = (sess?.waypoints ?? []).map(toInput);
  const priorPass = sess?.gpxPassthrough ?? null;
  const s = await importRoute(flockId, waypoints, passthrough);
  apply(s);
  let importedIds = s.waypoints.map((w) => w.id);
  store().recordHistory({
    label: "Import route",
    // importRoute can't take an empty list (the server rejects it), so undoing an
    // import into a previously-EMPTY flock clears the route by removing each
    // imported point; over an existing route it just re-imports the prior one.
    undo:
      priorWps.length > 0
        ? () => importRoute(flockId, priorWps, priorPass)
        : async () => {
            let r = store().session ?? s;
            for (const id of importedIds) {
              try {
                r = await removeWaypoint(flockId, id);
              } catch {
                /* already gone (e.g. removed on another device) */
              }
            }
            return r;
          },
    redo: async () => {
      const r = await importRoute(flockId, waypoints, passthrough);
      importedIds = r.waypoints.map((w) => w.id);
      return r;
    },
  });
  return s;
}

export async function uSetUnit(flockId: string, unit: Unit): Promise<FlockSession> {
  const prior = store().session?.unitPreference ?? "km";
  const s = await setUnit(flockId, unit);
  apply(s);
  store().recordHistory({
    label: "Change units",
    undo: () => setUnit(flockId, prior),
    redo: () => setUnit(flockId, unit),
  });
  return s;
}

/**
 * A discrete participant edit (e.g. dragging your own start on the map). Reverts
 * the whole participant to its pre-edit constraints on undo. The participant FORM
 * records its own single entry on close via recordParticipantEdit (so per-keystroke
 * autosaves don't each become an undo step).
 */
export async function uUpdateParticipant(
  flockId: string,
  id: string,
  updates: Partial<ParticipantConstraints>,
  label = "Edit participant",
): Promise<FlockSession> {
  const before = store().session?.participants.find((p) => p.id === id);
  const s = await updateParticipant(flockId, id, updates);
  apply(s);
  if (before) {
    const prior = fullConstraints(before);
    store().recordHistory({
      label,
      undo: () => updateParticipant(flockId, id, prior),
      redo: () => updateParticipant(flockId, id, updates),
    });
  }
  return s;
}

/** Record ONE undo step for a participant-form edit session (the autosave already
 *  performed the writes). prior = constraints when the form opened; next = on close. */
export function recordParticipantEdit(
  flockId: string,
  id: string,
  prior: ParticipantConstraints,
  next: ParticipantConstraints,
): void {
  store().recordHistory({
    label: "Edit your details",
    undo: () => updateParticipant(flockId, id, prior),
    redo: () => updateParticipant(flockId, id, next),
  });
}
