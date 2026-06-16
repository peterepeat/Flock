import { create } from "zustand";

import type { CalcWarning } from "@/lib/routing-types";
import type { FlockSession, LatLng } from "@/lib/types";

export type FlockStatus = "loading" | "ready" | "notfound" | "error";
export type CalcStatus = "idle" | "working" | "error";

interface FlockState {
  flockId: string | null;
  session: FlockSession | null;
  status: FlockStatus;
  lastSyncedUpdatedAt: string | null;

  // UI state (not persisted server-side)
  formOpen: boolean;
  editingParticipantId: string | null; // null while form is open => adding new
  hoveredParticipantId: string | null;
  expandedParticipantId: string | null; // schedule expanded (used later)
  draftStart: LatLng | null; // pin placed via map click while form open (map → form)
  pendingStart: LatLng | null; // the open form's current start, shown live on the map (form → map)
  placingPin: boolean; // map is in "click to place start" mode

  // Shared-waypoint placement
  placingWaypoint: boolean; // map is in "click to place a shared waypoint" mode
  waypointPin: LatLng | null; // location chosen for the waypoint being added (map → form)

  // Route calculation feedback
  calcStatus: CalcStatus;
  calcWarnings: CalcWarning[];

  setFlockId: (id: string) => void;
  setStatus: (status: FlockStatus) => void;
  /** Replace session if the incoming one is newer (or forced after a local write). */
  applyServerSession: (session: FlockSession, force?: boolean) => boolean;

  openAddForm: () => void;
  openEditForm: (participantId: string) => void;
  closeForm: () => void;
  setHovered: (participantId: string | null) => void;
  setExpanded: (participantId: string | null) => void;
  setDraftStart: (ll: LatLng | null) => void;
  setPendingStart: (ll: LatLng | null) => void;
  setPlacingPin: (placing: boolean) => void;
  setPlacingWaypoint: (placing: boolean) => void;
  setWaypointPin: (ll: LatLng | null) => void;
  setCalcStatus: (status: CalcStatus) => void;
  setCalcWarnings: (warnings: CalcWarning[]) => void;
}

export const useFlockStore = create<FlockState>((set, get) => ({
  flockId: null,
  session: null,
  status: "loading",
  lastSyncedUpdatedAt: null,

  formOpen: false,
  editingParticipantId: null,
  hoveredParticipantId: null,
  expandedParticipantId: null,
  draftStart: null,
  pendingStart: null,
  placingPin: false,
  placingWaypoint: false,
  waypointPin: null,

  calcStatus: "idle",
  calcWarnings: [],

  setFlockId: (id) => set({ flockId: id }),
  setStatus: (status) => set({ status }),

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
    }),
  setHovered: (participantId) => set({ hoveredParticipantId: participantId }),
  setExpanded: (participantId) => set({ expandedParticipantId: participantId }),
  setDraftStart: (ll) => set({ draftStart: ll }),
  setPendingStart: (ll) => set({ pendingStart: ll }),
  setPlacingPin: (placing) => set({ placingPin: placing }),
  setPlacingWaypoint: (placing) => set({ placingWaypoint: placing }),
  setWaypointPin: (ll) => set({ waypointPin: ll }),
  setCalcStatus: (status) => set({ calcStatus: status }),
  setCalcWarnings: (warnings) => set({ calcWarnings: warnings }),
}));
