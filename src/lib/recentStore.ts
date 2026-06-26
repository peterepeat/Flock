// ---------------------------------------------------------------------------
// Per-browser convenience caches in localStorage. Two independent lists, each
// capped at 10, most-recent first:
//
//  • recent LOCATIONS — places you TYPED + picked from the address search (never
//    map-drops or GPX imports). Offered as the top options before/while typing so
//    a place you used once is one tap away — and so we skip the server lookup when
//    your own recents already cover the query (≥4 matches).
//
//  • recent RUNNERS — people YOU saved (yourself / your friends), so you can drop
//    them into a new flock by name and reuse their prefs. Kept fresh: when anyone
//    edits a same-named runner, the cached copy updates.
//
// LOOSELY COUPLED: a pure localStorage helper. No store, no engine, no server. The
// I/O is SSR / private-mode safe (degrades to in-memory-nothing on failure). The
// match/upsert/sync logic is pure + exported for tests.
// ---------------------------------------------------------------------------

import type { GeocodeResult, LocationPin, Participant, ParticipantConstraints } from "./types";

const LOCATIONS_KEY = "flock.recentLocations";
const RUNNERS_KEY = "flock.recentRunners";
const FLOCKS_KEY = "flock.recentFlocks";
const MAX = 10;
const FLOCKS_MAX = 15; // navigation history — tiny {id,name} entries, so keep a few more

function readArray<T>(key: string): T[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeArray<T>(key: string, v: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode / SSR / quota — the cache is best-effort, never load-bearing */
  }
}

// ===== recent LOCATIONS =====================================================

const isLoc = (r: unknown): r is GeocodeResult =>
  !!r && typeof (r as GeocodeResult).lat === "number" && typeof (r as GeocodeResult).lng === "number" && typeof (r as GeocodeResult).shortName === "string";

/** Same physical spot ⇒ same entry (dedup key); coords to ~11 m. */
export const locationKey = (r: GeocodeResult): string => `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`;

export function getRecentLocations(): GeocodeResult[] {
  return readArray<GeocodeResult>(LOCATIONS_KEY).filter(isLoc);
}

/** Record a TYPED + selected place. Move-to-front, dedup by spot, cap 10. */
export function pushRecentLocation(r: GeocodeResult): void {
  if (!isLoc(r)) return;
  const k = locationKey(r);
  writeArray(LOCATIONS_KEY, [r, ...getRecentLocations().filter((x) => locationKey(x) !== k)].slice(0, MAX));
}

/** Recents whose label contains the query (case-insensitive). Empty query → all of them. */
export function matchLocations(recents: GeocodeResult[], query: string): GeocodeResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return recents;
  return recents.filter((r) => `${r.shortName} ${r.displayName}`.toLowerCase().includes(q));
}

// ===== recent RUNNERS =======================================================

const nameKey = (name: string) => name.trim().toLowerCase();
const isRunner = (r: unknown): r is ParticipantConstraints =>
  !!r && typeof (r as ParticipantConstraints).name === "string" && (r as ParticipantConstraints).name.trim().length > 0;

// Keep ONLY the constraint fields — never id / color / addedAt leak into the cache.
function pickConstraints(x: ParticipantConstraints): ParticipantConstraints {
  return {
    name: x.name.trim(),
    startPin: x.startPin,
    finishPin: x.finishPin,
    maxDistanceKm: x.maxDistanceKm,
    pace: x.pace,
    earliestStartTime: x.earliestStartTime,
    latestFinishTime: x.latestFinishTime,
  };
}

export function getRecentRunners(): ParticipantConstraints[] {
  return readArray<ParticipantConstraints>(RUNNERS_KEY).filter(isRunner).map(pickConstraints);
}

/** YOUR save → move-to-front, dedup by (normalised) name, cap 10. */
export function upsertRecentRunner(c: ParticipantConstraints): void {
  if (!isRunner(c)) return;
  const k = nameKey(c.name);
  writeArray(RUNNERS_KEY, [pickConstraints(c), ...getRecentRunners().filter((x) => nameKey(x.name) !== k)].slice(0, MAX));
}

/** Anyone edited a runner: refresh any cached entry of the SAME name IN PLACE (no reorder, no new
 *  entries — only YOUR saves add). Keeps "your friends" current even when someone else tweaks them. */
export function syncRecentRunners(participants: Participant[]): void {
  const cached = getRecentRunners();
  if (cached.length === 0) return;
  const byName = new Map(participants.map((p) => [nameKey(p.name), p]));
  let changed = false;
  const next = cached.map((c) => {
    const p = byName.get(nameKey(c.name));
    if (!p) return c;
    const fresh = pickConstraints(p);
    if (JSON.stringify(fresh) === JSON.stringify(c)) return c;
    changed = true;
    return fresh;
  });
  if (changed) writeArray(RUNNERS_KEY, next);
}

/** Recents whose name contains the query. Empty query → all of them. */
export function matchRunners(recents: ParticipantConstraints[], query: string): ParticipantConstraints[] {
  const q = query.trim().toLowerCase();
  if (!q) return recents;
  return recents.filter((r) => r.name.toLowerCase().includes(q));
}

/** A PERFECT duplicate — every constraint field matches, not just the name. Used to hide a cached
 *  runner who is already in the current flock identically (re-adding them would just duplicate). */
export function isSameRunner(a: ParticipantConstraints, b: ParticipantConstraints): boolean {
  return JSON.stringify(pickConstraints(a)) === JSON.stringify(pickConstraints(b));
}

/** Make a cached runner usable in a DIFFERENT flock: a "waypoint" pin can't carry across flocks
 *  (its id is local), so it degrades to "no preference"; a manual place / auto carries fine. */
export function recentRunnerToConstraints(c: ParticipantConstraints): ParticipantConstraints {
  return { ...pickConstraints(c), startPin: portablePin(c.startPin), finishPin: portablePin(c.finishPin) };
}

const portablePin = (pin: LocationPin): LocationPin => (pin && pin.kind === "waypoint" ? { kind: "auto" } : pin ?? { kind: "auto" });

// ===== recent FLOCKS ========================================================
// Lightweight {id, name} references to flocks you've opened — for the homepage "jump back in" list
// and the in-app switcher. The name refreshes on each visit so a renamed flock reads current.

export interface RecentFlock {
  id: string;
  name: string;
}

const isFlock = (r: unknown): r is RecentFlock =>
  !!r && typeof (r as RecentFlock).id === "string" && (r as RecentFlock).id.length > 0 && typeof (r as RecentFlock).name === "string";

export function getRecentFlocks(): RecentFlock[] {
  return readArray<RecentFlock>(FLOCKS_KEY).filter(isFlock);
}

/** Record a visit (or a name change): move-to-front, dedup by id, refresh the name, cap. */
export function pushRecentFlock(id: string, name: string): void {
  if (!id) return;
  const entry: RecentFlock = { id, name: (name ?? "").trim() };
  writeArray(FLOCKS_KEY, [entry, ...getRecentFlocks().filter((f) => f.id !== id)].slice(0, FLOCKS_MAX));
}

export function removeRecentFlock(id: string): void {
  writeArray(FLOCKS_KEY, getRecentFlocks().filter((f) => f.id !== id));
}
