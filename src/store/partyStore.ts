import { create } from "zustand";

// Flock Party UI state — deliberately its OWN tiny store, independent of
// flockStore. The party is a read-only, ephemeral overlay: it consumes routing
// output but never mutates the plan, the session, or anything server-side. Keeping
// it out of flockStore is the whole point — the feature is loosely coupled by
// construction, so it can be lifted out wholesale without leaving a trace.
interface PartyState {
  active: boolean; // is the disco playing?
  open: () => void;
  close: () => void;
}

export const usePartyStore = create<PartyState>((set) => ({
  active: false,
  open: () => set({ active: true }),
  close: () => set({ active: false }),
}));
