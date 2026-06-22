// ---------------------------------------------------------------------------
// Flock — the social-first model (the clean rebuild).
//
// ONE objective: maximise system-wide together-time = summed over all pairs of the
// minutes they are co-present, MOVING or at a STOP. Nothing else is optimised — no
// fairness term, no personal-distance target, no own-pace correction, no pace floor.
// The flock runs every shared stretch at the SLOWEST present runner's pace ("slowest
// wins" is the feature, not a tax — it's what lets everyone run together).
//
// The plan is a LAMINATION of runner world-lines over a shared route + one flock clock:
// a set of COMPANY BLOCKS, each a maximal co-present group on a contiguous stretch
// (moving) or at a stop (resting). A runner who can't stay with the flock the whole way
// peels off — as a singleton block (|S|=1) for now. Concurrent sub-flocks at independent
// paces are deferred, but the atom (a block carries its own member-set + timing) and the
// TimingSolver seam keep them ADDITIVE later ("for, but not with").
// ---------------------------------------------------------------------------

import type { LatLng } from "../types";

export type Pace = number; // seconds per kilometre — the only pace unit, ever.

// --- the shared route the flock runs, in arc-length space -------------------
export interface Stop {
  km: number; // arc position of the dwell
  durationSec: number; // how long the flock rests here (>0)
  name: string;
}
export interface Route {
  coords: LatLng[];
  cumKm: number[]; // cumulative km at each coord
  totalKm: number;
  stops: Stop[]; // ascending by km; dwell = first-class together-time
}

// --- a runner's HARD constraints (everything optional; "no preference" = free) ----
// A bound is FREE (the engine places it to maximise togetherness) or FIXED at an arc
// position (resolved from a start/finish pinned to a waypoint or a manual point).
export type Bound = { kind: "free" } | { kind: "fixed"; km: number };

export interface Runner {
  id: string;
  pace: Pace; // "how fast can you run" — feeds slowest-present
  enter: Bound; // from the start pin
  exit: Bound; // from the finish pin
  maxDistanceKm: number | null; // "how far can you run" — hard cap on covered arc; null = none
  latestSec: number | null; // hard finish deadline (absolute seconds); null = none
  connectorKm: number; // solo distance to/from a manual pin off the route (0 for auto/waypoint)
}

export interface RunInput {
  route: Route;
  runners: Runner[];
  t0Sec: number; // resolved flock departure at km 0 (absolute seconds)
}

// --- output: the plan as company blocks -------------------------------------
export interface Block {
  members: string[]; // who is co-present on this stretch (≥1; ==1 is a solo singleton)
  loKm: number;
  hiKm: number; // loKm == hiKm for a dwell block
  startSec: number;
  endSec: number; // absolute flock-clock seconds
  paceSec: Pace | null; // null = dwell (rest)
}

export interface RunnerPlan {
  id: string;
  enterKm: number;
  exitKm: number;
  departSec: number; // when they leave their start (incl. co-arrival timing)
  arriveSec: number; // when they finish
  distanceKm: number; // covered arc + connectors
  togetherMinutes: number; // THEIR share: minutes they spent with ≥1 other
}

export interface Warning {
  id: string;
  message: string;
}

export interface Plan {
  blocks: Block[];
  runners: RunnerPlan[];
  togetherMinutes: number; // THE objective value: summed pairwise co-present minutes
  warnings: Warning[];
}
