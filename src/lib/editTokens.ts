// ---------------------------------------------------------------------------
// Client-side edit-token storage (localStorage).
//
// When you create a participant entry, the client generates a secret token,
// keeps it here keyed by flock id + participant id, and sends the raw token to
// the server (which stores only its hash). To edit/delete that entry later you
// present the token. Result: on this device you can edit only the entry you
// created. The link itself stays fully public.
// ---------------------------------------------------------------------------

import { newEditToken } from "./ids";

const STORAGE_KEY = "flock.editTokens.v1";

type TokenMap = Record<string, Record<string, string>>; // flockId -> participantId -> token

function read(): TokenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TokenMap) : {};
  } catch {
    return {};
  }
}

function write(map: TokenMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage full / disabled — non-fatal; the worst case is losing edit access.
  }
}

/** Create + persist a new token for a participant, returning the raw token. */
export function createToken(flockId: string, participantId: string): string {
  const token = newEditToken();
  const map = read();
  map[flockId] = map[flockId] || {};
  map[flockId][participantId] = token;
  write(map);
  return token;
}

/** Retrieve the stored token for a participant, or null if not ours. */
export function getToken(flockId: string, participantId: string): string | null {
  return read()[flockId]?.[participantId] ?? null;
}

/** True if this device created (and can edit) the given participant. */
export function ownsParticipant(flockId: string, participantId: string): boolean {
  return getToken(flockId, participantId) != null;
}

/** All participant ids this device owns within a flock. */
export function ownedParticipantIds(flockId: string): string[] {
  return Object.keys(read()[flockId] ?? {});
}

export function forgetToken(flockId: string, participantId: string): void {
  const map = read();
  if (map[flockId]) {
    delete map[flockId][participantId];
    write(map);
  }
}
