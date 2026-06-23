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
  maxDistanceKm: number | null; // "how far can you run" — hard cap on TOTAL distance (connector + arc); null = none
  earliestSec: number | null; // hard "can't start before" floor (absolute seconds); null = none
  latestSec: number | null; // hard finish deadline (absolute seconds); null = none
  // Solo connector runs to/from a manual pin off the route (0 for auto/waypoint). Kept as
  // two physical legs because they affect timing ASYMMETRICALLY: the approach (home→enter)
  // shifts the DEPARTURE earlier; the egress (exit→home) shifts the ARRIVAL later. Only the
  // distance cap sees them together (the sum).
  approachKm: number; // home → enter point
  egressKm: number; // exit point → home
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

// A runner's constraints are mutually unsatisfiable (a contradiction), so they cannot really
// participate. The plan must NOT silently fabricate a window for them — it parks them at a
// feasible anchor (their own tightest hard floor) and names the conflict in a warning.
export type Conflict =
  | { kind: "cap-vs-pin"; capKm: number; enterPinKm: number | null; exitPinKm: number | null }
  | { kind: "cap-too-short"; capKm: number; commuteKm: number } // the connector commute alone busts the cap, or cap≈0 with a pin
  | { kind: "earliest-after-latest"; earliestSec: number; latestSec: number } // connector-aware es>lf
  | { kind: "earliest-unreachable"; earliestSec: number; t0Sec: number } // a fixed flock start departs before this runner can
  | { kind: "latest-unreachable"; latestSec: number; t0Sec: number } // the flock starts too late for this deadline
  | { kind: "window-empty" }; // the constraints leave no room to run with the flock

export interface RunnerPlan {
  id: string;
  enterKm: number;
  exitKm: number;
  departSec: number; // when they leave their start (incl. co-arrival timing)
  arriveSec: number; // when they finish
  distanceKm: number; // covered arc + connectors
  togetherMinutes: number; // THEIR share: minutes they spent with ≥1 other
  conflict: Conflict | null; // null iff a genuine participant; set iff parked-infeasible
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
