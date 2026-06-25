"use client";

import { useEffect, useState, type ReactNode } from "react";

import { isPartyActive } from "@/lib/party/simulate";
import type { ActiveTab } from "@/store/flockStore";
import { useFlockStore } from "@/store/flockStore";

/**
 * Mobile-only bottom nav. Toggles full-screen panels over the persistent map; "Map" shows the
 * bare canvas. Hidden on desktop (the fixed column lives there) and while a "tap the map to
 * place" mode is active (the confirm bar owns the bottom then). Sits above the panel (z-[1100]
 * > the panel's z-[1000]) and pads for the iOS home indicator.
 */
export default function MobileTabBar() {
  const activeTab = useFlockStore((s) => s.activeTab);
  const setActiveTab = useFlockStore((s) => s.setActiveTab);
  const placingPin = useFlockStore((s) => s.placingPin);
  const placingFinish = useFlockStore((s) => s.placingFinish);
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);
  const peopleCount = useFlockStore((s) => s.session?.participants.length ?? 0);
  // While Flock Party plays (the flock is locked), the disco takes over the map —
  // hide the nav so a tab tap can't slide a panel over the running show.
  const partyActive = useFlockStore((s) => isPartyActive(s.session));

  // Hide while the on-screen keyboard is up (a text field is focused) — the fixed bar would
  // otherwise float over the field, and the address dropdown wants the room.
  const [inputFocused, setInputFocused] = useState(false);
  useEffect(() => {
    const isText = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    const onIn = (e: FocusEvent) => { if (isText(e.target)) setInputFocused(true); };
    const onOut = (e: FocusEvent) => { if (isText(e.target)) setInputFocused(false); };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);

  if (placingPin || placingFinish || placingWaypoint || inputFocused || partyActive) return null;

  const tabs: { key: ActiveTab; label: string; icon: ReactNode; badge?: number }[] = [
    { key: "run", label: "Run", icon: <RunIcon /> },
    { key: "route", label: "Route", icon: <RouteIcon /> },
    { key: "runners", label: "Runners", icon: <RunnersIcon />, badge: peopleCount || undefined },
    { key: "map", label: "Map", icon: <MapIcon /> },
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-[1100] flex border-t border-white/10 bg-surface md:hidden"
      style={{ height: "calc(4rem + env(safe-area-inset-bottom))", paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Sections"
    >
      {tabs.map((t) => {
        const active = activeTab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition ${
              active ? "text-accent" : "text-fog hover:text-text-dim"
            }`}
          >
            <span className="relative">
              {t.icon}
              {t.badge != null && (
                <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-white">
                  {t.badge}
                </span>
              )}
            </span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

const SVG = (props: { children: ReactNode }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {props.children}
  </svg>
);

// Stopwatch — the run's time + distance.
function RunIcon() {
  return (
    <SVG>
      <circle cx="12" cy="13.5" r="7" />
      <path d="M12 13.5V9.5" />
      <path d="M10 2.5h4" />
      <path d="M12 2.5v2" />
    </SVG>
  );
}

// A route between two points — the shared waypoints.
function RouteIcon() {
  return (
    <SVG>
      <circle cx="5.5" cy="18.5" r="2.3" />
      <circle cx="18.5" cy="5.5" r="2.3" />
      <path d="M7.5 17.5C12.5 15.5 9 8 16.5 6.5" strokeDasharray="2 2.4" />
    </SVG>
  );
}

// Two runners — the people.
function RunnersIcon() {
  return (
    <SVG>
      <circle cx="9" cy="7" r="3.1" />
      <path d="M3.2 19c0-3.2 2.6-5.4 5.8-5.4s5.8 2.2 5.8 5.4" />
      <path d="M16.2 4.3a3.1 3.1 0 0 1 0 5.7" />
      <path d="M17.6 13.8c2 .6 3.4 2.4 3.4 4.7" />
    </SVG>
  );
}

// Folded map — the review canvas.
function MapIcon() {
  return (
    <SVG>
      <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4z" />
      <path d="M9 4v14" />
      <path d="M15 6v14" />
    </SVG>
  );
}
