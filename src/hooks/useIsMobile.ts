import { useSyncExternalStore } from "react";

// Live "are we at the mobile breakpoint?" hook. Mirrors Tailwind's `md` (≥768px = desktop)
// and `isMobileViewport()`. useSyncExternalStore keeps SSR safe (server snapshot = desktop)
// and re-renders on breakpoint changes (rotate / resize) without a hydration error.
const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches, // client
    () => false, // server: default to desktop
  );
}
