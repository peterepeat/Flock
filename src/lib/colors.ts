// Participant route colours — assigned in order. Avoids pure red/green for
// colour-blind accessibility (see spec Visual design).
export const PARTICIPANT_COLORS = [
  "#E8855A", // p1 coral
  "#4ABFB0", // p2 teal (matches --together)
  "#D4A847", // p3 amber
  "#8B6FC4", // p4 violet
  "#4A8FC4", // p5 sky
  "#C44A7A", // p6 rose
];

/** Pick the next colour not already used; cycle if the flock is large. */
export function nextColor(usedColors: string[]): string {
  for (const c of PARTICIPANT_COLORS) {
    if (!usedColors.includes(c)) return c;
  }
  return PARTICIPANT_COLORS[usedColors.length % PARTICIPANT_COLORS.length];
}

/** First letter of a name, uppercased, for marker initials. */
export function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}
