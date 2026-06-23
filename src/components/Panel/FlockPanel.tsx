"use client";

import { useEffect, useRef } from "react";

import ParticipantForm from "@/components/Panel/ParticipantForm";
import ParticipantList from "@/components/Panel/ParticipantList";
import RunSettings from "@/components/Panel/RunSettings";
import Section from "@/components/Panel/Section";
import TogetherStat from "@/components/Panel/TogetherStat";
import WaypointsSection from "@/components/Panel/WaypointsSection";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { FlockSession } from "@/lib/types";
import { formatDistance } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

// "07:00" → "7am", "07:30" → "7:30am" — a friendly glance value for the summaries.
function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${period}` : `${h12}${period}`;
}

// One-line summaries — desktop concertina chips + mobile tab subtitles.
function runSummary(s: FlockSession): string {
  const a = s.startAnchor;
  const time = a.kind === "auto" ? "7am" : clockLabel(a.time);
  // Only show distance when it's an explicit value — a bare "Auto" token next to a concrete
  // time reads ambiguously, so omit it when the distance is left automatic.
  return s.intendedDistanceKm != null
    ? `${time} · ${formatDistance(s.intendedDistanceKm, s.unitPreference)}`
    : time;
}
function routeSummary(s: FlockSession): string {
  const n = s.waypoints.length;
  if (n === 0) return "None yet";
  const stops = s.waypoints.filter((w) => w.stopMinutes > 0).length;
  return `${n} ${n === 1 ? "waypoint" : "waypoints"}${stops > 0 ? ` · ${stops} ${stops === 1 ? "stop" : "stops"}` : ""}`;
}
function runnersSummary(s: FlockSession): string {
  const n = s.participants.length;
  return n === 0 ? "No one yet" : `${n} ${n === 1 ? "person" : "people"}`;
}

export default function FlockPanel() {
  const isMobile = useIsMobile();
  return isMobile ? <MobilePanel /> : <DesktopPanel />;
}

// --- Desktop: the fixed left column with the three concertina Sections (unchanged IA) ------
function DesktopPanel() {
  const session = useFlockStore((s) => s.session);
  const formOpen = useFlockStore((s) => s.formOpen);
  const editingId = useFlockStore((s) => s.editingParticipantId);
  const openAddForm = useFlockStore((s) => s.openAddForm);
  const calcError = useFlockStore((s) => s.calcError);
  const scrollRef = useRef<HTMLDivElement>(null);

  const locked = session?.lockedAt != null;
  const tooFarApart =
    !!session?.computedRoutes &&
    (session?.participants.length ?? 0) >= 2 &&
    (session.sharedSegments?.length ?? 0) === 0;

  // When the form opens, reset the scroll so its first field is in view.
  useEffect(() => {
    if (formOpen) scrollRef.current?.scrollTo({ top: 0 });
  }, [formOpen]);

  return (
    <aside className="relative z-10 flex h-full w-80 flex-col border-r border-white/5 bg-surface-mid">
      <div ref={scrollRef} className="flock-scroll flex-1 overflow-y-auto px-5 py-4">
        {formOpen ? (
          <>
            <h2 className="mb-4 text-lg font-semibold">
              {editingId ? "Edit your details" : "Join the flock"}
            </h2>
            <ParticipantForm key={editingId ?? "new"} />
          </>
        ) : (
          <div className="space-y-3">
            {session && (
              <Section title="The run" summary={runSummary(session)} sectionKey="run">
                <RunSettings />
              </Section>
            )}

            {session && !(locked && session.waypoints.length === 0) && (
              <Section
                title="The route"
                summary={routeSummary(session)}
                sectionKey="route"
                defaultOpen={session.waypoints.length === 0}
              >
                <WaypointsSection />
              </Section>
            )}

            {session && (
              <Section
                title="The runners"
                summary={runnersSummary(session)}
                sectionKey="runners"
                defaultOpen={session.participants.length < 2}
              >
                <ParticipantList />
                {!locked && (
                  <button
                    type="button"
                    onClick={openAddForm}
                    className="mt-3 w-full rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
                  >
                    + Join the flock
                  </button>
                )}
                {locked && (
                  <div className="mt-3 rounded-lg bg-surface-mid px-3 py-2.5 text-sm text-text-dim">
                    The plan is locked. Download your route below.
                  </div>
                )}
              </Section>
            )}

            {calcError && (
              <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-text">
                {calcError}
              </div>
            )}
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

// --- Mobile: full-screen panels over the persistent map, switched by the bottom nav --------
function MobilePanel() {
  const session = useFlockStore((s) => s.session);
  const activeTab = useFlockStore((s) => s.activeTab);
  const formOpen = useFlockStore((s) => s.formOpen);
  const editingId = useFlockStore((s) => s.editingParticipantId);
  const openAddForm = useFlockStore((s) => s.openAddForm);
  const calcError = useFlockStore((s) => s.calcError);
  const placingPin = useFlockStore((s) => s.placingPin);
  const placingFinish = useFlockStore((s) => s.placingFinish);
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);
  const scrollRef = useRef<HTMLDivElement>(null);

  const locked = session?.lockedAt != null;
  const placing = placingPin || placingFinish || placingWaypoint;
  const tooFarApart =
    !!session?.computedRoutes &&
    (session?.participants.length ?? 0) >= 2 &&
    (session.sharedSegments?.length ?? 0) === 0;

  useEffect(() => {
    if (formOpen) scrollRef.current?.scrollTo({ top: 0 });
  }, [formOpen]);

  if (!session) return null;

  // The Map tab shows the bare canvas — no panel at all.
  const showPanel = activeTab !== "map";

  return (
    <>
      {showPanel && (
        // During a "tap the map to place" mode the panel is hidden (not unmounted — the editor's
        // local draft must survive) so the map behind is reachable; the confirm bar takes over.
        <aside
          className={`fixed inset-x-0 z-[1000] ${placing ? "hidden" : "flex"} flex-col bg-surface-mid`}
          style={{ top: "3.5rem", bottom: "calc(4rem + env(safe-area-inset-bottom))" }}
        >
          <div ref={scrollRef} className="flock-scroll flex-1 overflow-y-auto px-5 py-4">
            {activeTab === "run" && (
              <>
                <TabHeader title="The run" subtitle={runSummary(session)} />
                <RunSettings />
              </>
            )}

            {activeTab === "route" && (
              <>
                <TabHeader title="The route" subtitle={routeSummary(session)} />
                <WaypointsSection />
              </>
            )}

            {activeTab === "runners" &&
              (formOpen ? (
                <>
                  <h2 className="mb-4 text-lg font-semibold">
                    {editingId ? "Edit your details" : "Join the flock"}
                  </h2>
                  <ParticipantForm key={editingId ?? "new"} />
                </>
              ) : (
                <>
                  <TabHeader title="The runners" subtitle={runnersSummary(session)} />
                  <ParticipantList />
                  {!locked && (
                    <button
                      type="button"
                      onClick={openAddForm}
                      className="mt-3 w-full rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
                    >
                      + Join the flock
                    </button>
                  )}
                  {locked && (
                    <div className="mt-3 rounded-lg bg-surface px-3 py-2.5 text-sm text-text-dim">
                      The plan is locked. Download your route below.
                    </div>
                  )}
                  {calcError && (
                    <div className="mt-3 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-text">
                      {calcError}
                    </div>
                  )}
                  {tooFarApart && (
                    <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-xs text-text-dim">
                      Everyone’s a bit too far apart to flock together on this one.
                    </div>
                  )}
                  <div className="mt-3">
                    <TogetherStat />
                  </div>
                </>
              ))}
          </div>
        </aside>
      )}

      {placing && <ConfirmBar isWaypoint={placingWaypoint} />}
    </>
  );
}

function TabHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <span className="text-xs text-fog">{subtitle}</span>
    </div>
  );
}

// The "tap the map to place" confirm bar — replaces the bottom nav while a pin is being placed.
function ConfirmBar({ isWaypoint }: { isWaypoint: boolean }) {
  const setPlacingPin = useFlockStore((s) => s.setPlacingPin);
  const setPlacingFinish = useFlockStore((s) => s.setPlacingFinish);
  const setPlacingWaypoint = useFlockStore((s) => s.setPlacingWaypoint);
  const cancel = () => {
    setPlacingPin(false);
    setPlacingFinish(false);
    setPlacingWaypoint(false);
  };
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[1100] flex items-center justify-between gap-3 border-t border-white/10 bg-surface px-5 py-3 md:hidden"
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      <span className="text-sm text-text">
        Tap the map to place {isWaypoint ? "the waypoint" : "your pin"}
      </span>
      <button
        type="button"
        onClick={cancel}
        className="shrink-0 rounded-full border border-white/15 px-4 py-1.5 text-sm text-text-dim hover:text-text"
      >
        Cancel
      </button>
    </div>
  );
}
