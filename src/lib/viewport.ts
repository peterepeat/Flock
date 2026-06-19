// Whether we're at the mobile bottom-sheet breakpoint. Mirrors Tailwind's `md`
// (≥768px is desktop). Used to gate sheet-collapse gestures so they never fire on
// the desktop fixed-column layout. Safe on the server (returns false).
export function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}
