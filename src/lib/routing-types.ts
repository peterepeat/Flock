import type { LatLng } from "./types";

/** A geometry vertex annotated with cumulative distance + absolute clock time. */
export interface TimedPoint {
  ll: LatLng;
  cumKm: number; // distance from route start
  clockSec: number; // absolute seconds since midnight (includes rest offsets)
}

/** A stop inserted at a point index along the route. */
export interface RouteStop {
  idx: number; // vertex index where the stop happens
  durationSec: number;
  name: string;
  location: LatLng;
}

/** A participant's route after timing has been applied. */
export interface TimedRoute {
  participantId: string;
  paceSecPerKm: number;
  points: TimedPoint[];
  stops: RouteStop[]; // shared-waypoint stops, ascending by idx
}

/** A run of contiguous points on one participant's route spent with a companion. */
export interface CompanionInterval {
  startIdx: number;
  endIdx: number;
  companionId: string;
  /** Pace to display on this stretch — always the slower of the two. */
  paceSecPerKm: number;
}

export interface PairSummary {
  participantA: string;
  participantB: string;
  togetherMinutes: number;
  togetherStretchCount: number;
}

export interface CalcWarning {
  participantId: string;
  message: string;
}
