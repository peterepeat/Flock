// Playful speech-bubble copy + avatar vocabulary for Flock Party. Pure data — a
// deterministic pick (hashed off the event id) keeps a given bubble's words stable
// across re-renders, so it never flickers between phrasings mid-show.

import type { PartyEventKind } from "@/lib/party/simulate";

const PHRASES: Record<PartyEventKind, string[]> = {
  start: ["Let's go! 🎶", "Off we boogie!", "Lace up! ✨", "Here we go! 🪩", "Warm up the legs!"],
  meet: ["Hey hey! 👋", "There you are! 🙌", "Squad! 🪩", "Together now! 💫", "Yesss, company!"],
  farewell: ["Byeee! 👋", "See ya! 💕", "Catch you later!", "Solo from here ✌️", "Was fun! 🫶"],
  "stop-arrive": ["Coffee! ☕", "Pit stop ☕", "Stretch break!", "Treat yourself 🍰", "Refuel! ⛽"],
  "stop-depart": ["Back at it! 🏃", "Onwards! ➡️", "Caffeinated 😤", "Let's roll!", "Round two!"],
  finish: ["Made it! 🏁", "Done & dusted! 🎉", "Nailed it! 💪", "What a run! 🌟", "Home! 🏡"],
};

/** A small deterministic hash → stable phrase choice for an event id. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function phraseFor(kind: PartyEventKind, id: string): string {
  const pool = PHRASES[kind];
  return pool[hash(id) % pool.length];
}

// Disco dancers, alternated per runner so a flock reads as a crowd on the floor.
const DANCERS = ["🕺", "💃"];
export const dancerFor = (index: number): string => DANCERS[index % DANCERS.length];
