"use client";

import { useEffect, useRef } from "react";

import ParticipantForm from "@/components/Panel/ParticipantForm";
import ParticipantList from "@/components/Panel/ParticipantList";
import TogetherStat from "@/components/Panel/TogetherStat";
import WaypointsSection from "@/components/Panel/WaypointsSection";
import { isMobileViewport } from "@/lib/viewport";
import { useFlockStore } from "@/store/flockStore";

export default function FlockPanel() {
  const session = useFlockStore((s) => s.session);
  const formOpen = useFlockStore((s) => s.formOpen);
  const editingId = useFlockStore((s) => s.editingParticipantId);
  const openAddForm = useFlockStore((s) => s.openAddForm);
  const calcError = useFlockStore((s) => s.calcError);
  const sheetExpanded = useFlockStore((s) => s.sheetExpanded);
  const setSheetExpanded = useFlockStore((s) => s.setSheetExpanded);
  const placingPin = useFlockStore((s) => s.placingPin);
  const placingFinish = useFlockStore((s) => s.placingFinish);
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);
  const scrollRef = useRef<HTMLDivElement>(null);

  const locked = session?.lockedAt != null;
  // While a "tap the map to drop a pin" mode is active, peek the sheet so the map
  // the user is being asked to tap is actually reachable. It re-expands on its own
  // once the pin lands (the placing flag flips off) and the editor is shown again.
  const placing = placingPin || placingFinish || placingWaypoint;
  const expanded = sheetExpanded && !placing;
  // Everyone has routes but nobody overlaps → too far apart.
  const withStart = session?.participants.length ?? 0;
  const tooFarApart =
    !!session?.computedRoutes &&
    withStart >= 2 &&
    (session.sharedSegments?.length ?? 0) === 0;

  // When the form opens (often from a map tap), reset the scroll so its first
  // field is in view — otherwise the sheet just looks like a wall of content with
  // no obvious relationship to what was tapped. Reset instantly on open (the form
  // content is swapped fresh, so there's nothing to animate) and don't re-fire
  // mid-edit, so it can never fight a scroll the user starts. (The waypoint editor
  // scrolls itself into view from WaypointsSection.)
  useEffect(() => {
    if (formOpen) scrollRef.current?.scrollTo({ top: 0 });
  }, [formOpen]);

  // Tapping a collapsed sheet anywhere that isn't an actual control opens it
  // (mobile only — the desktop column has no peek state). Taps on buttons / links
  // / inputs keep doing their own thing.
  const onSheetClick = (e: React.MouseEvent) => {
    if (sheetExpanded || !isMobileViewport()) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, label, [role='button']")) return;
    setSheetExpanded(true);
  };

  return (
    <aside
      onClick={onSheetClick}
      className={[
        // Desktop: left column.
        "md:relative md:z-10 md:flex md:h-full md:w-80 md:flex-col md:border-r md:border-white/5",
        // Mobile: bottom sheet — a small peek at rest (map-first), nearly full
        // height while editing.
        "fixed inset-x-0 bottom-0 z-[1000] flex flex-col rounded-t-2xl border-t border-white/10 md:rounded-none md:border-t-0",
        "bg-surface-mid shadow-panel",
        expanded ? "h-[90dvh] md:h-full" : "h-[24dvh] md:h-full",
        "transition-[height] duration-300",
      ].join(" ")}
    >
      {/* Mobile drag handle — a generous tap target around the visible grabber. */}
      <button
        type="button"
        onClick={() => setSheetExpanded(!sheetExpanded)}
        className="mx-auto flex h-7 w-full max-w-[140px] shrink-0 items-center justify-center md:hidden"
        aria-label={sheetExpanded ? "Collapse panel" : "Expand panel"}
        aria-expanded={sheetExpanded}
      >
        <span className="h-1.5 w-10 rounded-full bg-surface-lift" />
      </button>

      <div ref={scrollRef} className="flock-scroll flex-1 overflow-y-auto px-5 py-4">
        {formOpen ? (
          <>
            <h2 className="mb-4 text-lg font-semibold">
              {editingId ? "Edit your details" : "Join the flock"}
            </h2>
            <ParticipantForm key={editingId ?? "new"} />
          </>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Your flock</h2>
              <span className="mono text-xs text-fog">
                {session?.participants.length ?? 0}{" "}
                {(session?.participants.length ?? 0) === 1 ? "person" : "people"}
              </span>
            </div>

            {!locked && (
              <button
                type="button"
                onClick={openAddForm}
                className="w-full rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
              >
                + Join the flock
              </button>
            )}

            {locked && (
              <div className="rounded-lg bg-surface px-3 py-2.5 text-sm text-text-dim">
                The plan is locked. Download your route below.
              </div>
            )}

            <ParticipantList />

            {/* Waypoints are universal — show them even before anyone joins, so a
                flock can be sketched as a route first, people after. */}
            {session && <WaypointsSection />}

            {calcError && (
              <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-text">
                {calcError}
              </div>
            )}

            {/* Per-person warnings now live as an indicator on each tile
                (ParticipantList). This stays for the whole-flock case. */}
            {tooFarApart && (
              <div className="rounded-lg bg-surface px-3 py-2 text-xs text-text-dim">
                Everyone’s a bit too far apart to flock together on this one.
              </div>
            )}

            <TogetherStat />
          </div>
        )}
      </div>
    </aside>
  );
}
