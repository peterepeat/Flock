import { create } from "zustand";

import { createLogger } from "@/lib/logger";
import type { CalcWarning } from "@/lib/routing-types";
import type { FlockSession, LatLng } from "@/lib/types";

const log = createLogger("history");

export type FlockStatus = "loading" | "ready" | "notfound" | "error";
export type CalcStatus = "idle" | "working" | "error";

// The waypoint add/edit editor. In the store (not local to WaypointsSection) so
// the map can open a waypoint for editing and coordinate the "tap empty map to
// add" gesture. One editor is open at a time.
export type WaypointEditorState = { mode: "closed" } | { mode: "add" } | { mode: "edit"; id: string };

// A single undoable local edit. `undo`/`redo` issue the compensating / original
// mutation (a normal PatchAction via flockApi) and return the resulting session,
// which undo()/redo() then apply. Per-device only.
export interface HistoryEntry {
  label: string;
  undo: () => Promise<FlockSession>;
  redo: () => Promise<FlockSession>;
}

const HISTORY_MAX = 50;

interface FlockState {
  flockId: string | null;
  session: FlockSession | null;
  status: FlockStatus;
  lastSyncedUpdatedAt: string | null;

  // UI state (not persisted server-side)
  formOpen: boolean;
  editingParticipantId: string | null; // null while form is open => adding new
  hoveredParticipantId: string | null;
  selectedParticipantId: string | null; // clicked-to-focus: isolates that route on the map
  expandedParticipantId: string | null; // schedule expanded (used later)
  draftStart: LatLng | null; // pin placed via map click while form open (map → form)
  pendingStart: LatLng | null; // the open form's current start, shown live on the map (form → map)
  placingPin: boolean; // map is in "click to place start" mode
  draftFinish: LatLng | null; // finish pin placed via map click (map → form)
  pendingFinish: LatLng | null; // the open form's current finish, shown live on the map (form → map)
  placingFinish: boolean; // map is in "click to place finish" mode

  // Shared-waypoint placement
  placingWaypoint: boolean; // map is in "click to place a shared waypoint" mode
  waypointPin: LatLng | null; // location chosen for the waypoint being added (map → form)
  waypointEditor: WaypointEditorState; // which waypoint editor (add/edit) is open, if any

  // Route calculation feedback
  calcStatus: CalcStatus;
  calcWarnings: CalcWarning[];
  calcError: string | null; // flock-level failure (e.g. quota) shown until it resolves

  // Per-device undo/redo of this user's own edits (not shared across devices).
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  historyBusy: boolean;
  recordHistory: (entry: HistoryEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  setFlockId: (id: string) => void;
  setStatus: (status: FlockStatus) => void;
  /** Replace session if the incoming one is newer (or forced after a local write). */
  applyServerSession: (session: FlockSession, force?: boolean) => boolean;

  openAddForm: () => void;
  openEditForm: (participantId: string) => void;
  closeForm: () => void;
  setHovered: (participantId: string | null) => void;
  setSelected: (participantId: string | null) => void;
  setExpanded: (participantId: string | null) => void;
  setDraftStart: (ll: LatLng | null) => void;
  setPendingStart: (ll: LatLng | null) => void;
  setPlacingPin: (placing: boolean) => void;
  setDraftFinish: (ll: LatLng | null) => void;
  setPendingFinish: (ll: LatLng | null) => void;
  setPlacingFinish: (placing: boolean) => void;
  setPlacingWaypoint: (placing: boolean) => void;
  setWaypointPin: (ll: LatLng | null) => void;
  openAddWaypoint: () => void;
  openEditWaypoint: (waypointId: string) => void;
  closeWaypointEditor: () => void;
  setCalcStatus: (status: CalcStatus) => void;
  setCalcWarnings: (warnings: CalcWarning[]) => void;
  setCalcError: (message: string | null) => void;
}

export const useFlockStore = create<FlockState>((set, get) => ({
  flockId: null,
  session: null,
  status: "loading",
  lastSyncedUpdatedAt: null,

  formOpen: false,
  editingParticipantId: null,
  hoveredParticipantId: null,
  selectedParticipantId: null,
  expandedParticipantId: null,
  draftStart: null,
  pendingStart: null,
  placingPin: false,
  draftFinish: null,
  pendingFinish: null,
  placingFinish: false,
  placingWaypoint: false,
  waypointPin: null,
  waypointEditor: { mode: "closed" },

  calcStatus: "idle",
  calcWarnings: [],
  calcError: null,

  undoStack: [],
  redoStack: [],
  historyBusy: false,

  setFlockId: (id) => set({ flockId: id, undoStack: [], redoStack: [] }),
  setStatus: (status) => set({ status }),

  // Push a local edit's inverse; a new edit always clears the redo branch.
  recordHistory: (entry) =>
    set((s) => ({
      undoStack: [...s.undoStack, entry].slice(-HISTORY_MAX),
      redoStack: [],
    })),

  undo: async () => {
    const { undoStack, historyBusy, applyServerSession } = get();
    if (historyBusy || undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    set({ historyBusy: true });
    try {
      const session = await entry.undo();
      applyServerSession(session, true);
      set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, entry] }));
    } catch (err) {
      // The target likely changed under us (e.g. another device edited it); drop
      // the now-unapplicable entry rather than leaving a broken undo.
      log.error("undo failed — dropping entry", { label: entry.label, error: String(err) });
      set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
    } finally {
      set({ historyBusy: false });
    }
  },

  redo: async () => {
    const { redoStack, historyBusy, applyServerSession } = get();
    if (historyBusy || redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    set({ historyBusy: true });
    try {
      const session = await entry.redo();
      applyServerSession(session, true);
      set((s) => ({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, entry] }));
    } catch (err) {
      log.error("redo failed — dropping entry", { label: entry.label, error: String(err) });
      set((s) => ({ redoStack: s.redoStack.slice(0, -1) }));
    } finally {
      set({ historyBusy: false });
    }
  },

  applyServerSession: (session, force = false) => {
    const prev = get().lastSyncedUpdatedAt;
    if (!force && prev && session.updatedAt === prev) {
      return false; // unchanged — no re-render churn
    }
    set({
      session,
      status: "ready",
      lastSyncedUpdatedAt: session.updatedAt,
    });
    return true;
  },

  openAddForm: () => set({ formOpen: true, editingParticipantId: null, draftStart: null }),
  openEditForm: (participantId) =>
    set({ formOpen: true, editingParticipantId: participantId, draftStart: null }),
  closeForm: () =>
    set({
      formOpen: false,
      editingParticipantId: null,
      placingPin: false,
      draftStart: null,
      pendingStart: null,
      placingFinish: false,
      draftFinish: null,
      pendingFinish: null,
    }),
  setHovered: (participantId) => set({ hoveredParticipantId: participantId }),
  setSelected: (participantId) => set({ selectedParticipantId: participantId }),
  setExpanded: (participantId) => set({ expandedParticipantId: participantId }),
  setDraftStart: (ll) => set({ draftStart: ll }),
  setPendingStart: (ll) => set({ pendingStart: ll }),
  setPlacingPin: (placing) => set({ placingPin: placing }),
  setDraftFinish: (ll) => set({ draftFinish: ll }),
  setPendingFinish: (ll) => set({ pendingFinish: ll }),
  setPlacingFinish: (placing) => set({ placingFinish: placing }),
  setPlacingWaypoint: (placing) => set({ placingWaypoint: placing }),
  setWaypointPin: (ll) => set({ waypointPin: ll }),
  openAddWaypoint: () => set({ waypointEditor: { mode: "add" } }),
  // Editing a waypoint lives in the list view, so close the participant form and
  // any placing mode first.
  openEditWaypoint: (waypointId) =>
    set({
      waypointEditor: { mode: "edit", id: waypointId },
      formOpen: false,
      editingParticipantId: null,
      placingPin: false,
      placingFinish: false,
      selectedParticipantId: null, // editing a waypoint clears any route focus
      waypointPin: null, // drop any stray pin so it can't pop a spurious add
    }),
  closeWaypointEditor: () =>
    set({ waypointEditor: { mode: "closed" }, placingWaypoint: false, waypointPin: null }),
  setCalcStatus: (status) => set({ calcStatus: status }),
  setCalcWarnings: (warnings) => set({ calcWarnings: warnings }),
  setCalcError: (message) => set({ calcError: message }),
}));
