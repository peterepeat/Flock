"use client";

import { useEffect, useMemo, useRef } from "react";

import { useFlockStore } from "@/store/flockStore";
import { usePartyStore } from "@/store/partyStore";

/**
 * The "🪩 Flock Party" header button — a quiet invitation (the disco is an easter
 * egg, not the headline). Reads the session (never writes) and flips the
 * independent party store on. Hidden while playing (the map's ✕ cancels then);
 * disabled until there's a real, timed plan to bring to life. Icon-only on mobile.
 */
export default function PartyLaunch() {
  const active = usePartyStore((s) => s.active);
  const open = usePartyStore((s) => s.open);
  const routes = useFlockStore((s) => s.session?.computedRoutes);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Playable once at least one runner has a route that actually goes somewhere in
  // time (guards the empty / still-calculating / all-parked cases cheaply).
  const canParty = useMemo(
    () => !!routes?.some((r) => r.arrivalTime !== r.departureTime && r.geometry.coordinates.length > 1),
    [routes],
  );

  // When the party closes, return focus here (the button that opened it), so a
  // keyboard user isn't dropped at the top of the page.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) btnRef.current?.focus();
    wasActive.current = active;
  }, [active]);

  if (active) return null;

  return (
    <button
      type="button"
      ref={btnRef}
      onClick={open}
      disabled={!canParty}
      title={canParty ? "Watch the whole run come to life" : "Add runners and let the routes settle to throw a party"}
      aria-label="Start Flock Party"
      className="party-launch inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-text transition hover:bg-surface-lift disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="party-launch__ball text-sm leading-none">🪩</span>
      <span className="hidden sm:inline">Flock Party</span>
    </button>
  );
}
