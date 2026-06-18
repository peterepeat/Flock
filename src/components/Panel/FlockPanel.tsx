"use client";

import { useState } from "react";

import ParticipantForm from "@/components/Panel/ParticipantForm";
import ParticipantList from "@/components/Panel/ParticipantList";
import TogetherStat from "@/components/Panel/TogetherStat";
import WaypointsSection from "@/components/Panel/WaypointsSection";
import { useFlockStore } from "@/store/flockStore";

export default function FlockPanel() {
  const session = useFlockStore((s) => s.session);
  const formOpen = useFlockStore((s) => s.formOpen);
  const editingId = useFlockStore((s) => s.editingParticipantId);
  const openAddForm = useFlockStore((s) => s.openAddForm);
  const calcError = useFlockStore((s) => s.calcError);
  const [expanded, setExpanded] = useState(false);

  const locked = session?.lockedAt != null;
  // Everyone has routes but nobody overlaps → too far apart.
  const withStart = session?.participants.filter((p) => p.startLocation).length ?? 0;
  const tooFarApart =
    !!session?.computedRoutes &&
    withStart >= 2 &&
    (session.sharedSegments?.length ?? 0) === 0;
  // On mobile the sheet auto-expands when the form is open.
  const sheetExpanded = expanded || formOpen;

  return (
    <aside
      className={[
        // Desktop: left column.
        "md:relative md:z-10 md:flex md:h-full md:w-80 md:flex-col md:border-r md:border-white/5",
        // Mobile: bottom sheet.
        "fixed inset-x-0 bottom-0 z-[1000] flex flex-col rounded-t-2xl border-t border-white/10 md:rounded-none md:border-t-0",
        "bg-surface-mid shadow-panel",
        sheetExpanded ? "h-[78dvh] md:h-full" : "h-[40dvh] md:h-full",
        "transition-[height] duration-300",
      ].join(" ")}
    >
      {/* Mobile drag handle */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-surface-lift md:hidden"
        aria-label="Expand panel"
      />

      <div className="flock-scroll flex-1 overflow-y-auto px-5 py-4">
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
