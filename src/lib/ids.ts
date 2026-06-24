import { customAlphabet, nanoid } from "nanoid";

// 6-char flock id from an unambiguous alphabet (no 0/O/1/l/I) so links are
// easy to read aloud and type.
const FLOCK_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const flockNano = customAlphabet(FLOCK_ALPHABET, 6);

export function newFlockId(): string {
  return flockNano();
}

export function newParticipantId(): string {
  return nanoid(12);
}

export function newWaypointId(): string {
  return nanoid(10);
}
