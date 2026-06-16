// ---------------------------------------------------------------------------
// Unit conversion + display helpers.
//
// Internal storage is ALWAYS km + sec/km. These functions are the only place
// where conversion to the user's chosen unit happens.
// ---------------------------------------------------------------------------

import type { Unit } from "./types";

const KM_PER_MILE = 1.60934;
const MILES_PER_KM = 0.621371;

/** Pace, e.g. "5:30 / km" or "8:51 / mile". Input is sec/km. */
export function formatPace(secPerKm: number, unit: Unit): string {
  const secPerUnit = unit === "miles" ? secPerKm * KM_PER_MILE : secPerKm;
  const mins = Math.floor(secPerUnit / 60);
  const secs = Math.round(secPerUnit % 60);
  // Handle the 59.5→60 rounding edge.
  const m = secs === 60 ? mins + 1 : mins;
  const s = secs === 60 ? 0 : secs;
  return `${m}:${s.toString().padStart(2, "0")} / ${unit === "miles" ? "mile" : "km"}`;
}

/** Pace without the unit suffix, e.g. "5:30". Input is sec/km. */
export function formatPaceShort(secPerKm: number, unit: Unit): string {
  const secPerUnit = unit === "miles" ? secPerKm * KM_PER_MILE : secPerKm;
  const mins = Math.floor(secPerUnit / 60);
  const secs = Math.round(secPerUnit % 60);
  const m = secs === 60 ? mins + 1 : mins;
  const s = secs === 60 ? 0 : secs;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Distance, e.g. "7.8 km" or "4.8 miles". Input is km. */
export function formatDistance(km: number, unit: Unit): string {
  const val = unit === "miles" ? km * MILES_PER_KM : km;
  return `${val.toFixed(1)} ${unit}`;
}

/** Convert a value the user entered in their unit back to internal km. */
export function toKm(value: number, unit: Unit): number {
  return unit === "miles" ? value * KM_PER_MILE : value;
}

/** Convert internal km to the user's display unit (number only). */
export function fromKm(km: number, unit: Unit): number {
  return unit === "miles" ? km * MILES_PER_KM : km;
}

/** Convert a display pace (sec per user-unit) back to internal sec/km. */
export function paceToSecPerKm(secPerUnit: number, unit: Unit): number {
  return unit === "miles" ? secPerUnit / KM_PER_MILE : secPerUnit;
}

/** Duration in minutes → "3h 45min" or "45min". */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

/** "HH:MM" + minutes → "HH:MM" (24h, wraps at 24h defensively). */
export function addMinutesToTime(time: string, minutes: number): string {
  const [hh, mm] = time.split(":").map(Number);
  const base = (hh * 60 + mm + Math.round(minutes)) % (24 * 60);
  const wrapped = base < 0 ? base + 24 * 60 : base;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

// Pace slider bounds (internal sec/km): 3:30/km (fast) to 12:00/km (slow).
export const PACE_MIN_SEC_PER_KM = 210; // 3:30
export const PACE_MAX_SEC_PER_KM = 720; // 12:00

// Distance slider bounds (internal km).
export const DISTANCE_MIN_KM = 1;
export const DISTANCE_MAX_KM = 80;
