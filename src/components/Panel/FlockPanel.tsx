"use client";

import { useEffect, useRef } from "react";

import ParticipantForm from "@/components/Panel/ParticipantForm";
import ParticipantList from "@/components/Panel/ParticipantList";
import RunSettings from "@/components/Panel/RunSettings";
import Section from "@/components/Panel/Section";
import TogetherStat from "@/components/Panel/TogetherStat";
import WaypointsSection from "@/components/Panel/WaypointsSection";
import LockToggle from "@/components/ui/LockToggle";
import { useIsMobile } from "@/hooks/useIsMobile";
import { setSectionLock } from "@/lib/flockApi";
import { flockTimeLabel } from "@/lib/flockName";
import type { FlockSession, LockSection, Unit } from "@/lib/types";
import { formatDistance } from "@/lib/units";
import { useFlockStore, useUnit } from "@/store/flockStore";

// Shared label + toggle wiring for a section's advisory lock.
const SECTION_TITLE: Record<LockSection, string> = { run: "The run", route: "The route", runners: "The runners" };
function useSectionLock() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const apply = useFlockStore((s) => s.applyServerSession);
  const locks = useFlockStore((s) => s.session?.locks);
  return (section: LockSection) => {
    const locked = !!locks?.[section];
    return {
      locked,
      label: locked ? `Unlock ${SECTION_TITLE[section]}` : `Lock ${SECTION_TITLE[section]}`,
      onToggle: () => {
        void setSectionLock(flockId, section, !locked)
          .then((s) => apply(s, true))
          .catch(() => {});
      },
    };
  };
}

// One-line summaries — desktop concertina chips + mobile tab subtitles.
function runSummary(s: FlockSession, unit: Unit): string {
  // Same source as the flock NAME's time (flockTimeLabel) so the title and this chip never disagree.
  const time = flockTimeLabel(s);
  // Only show distance when it's an explicit value — a bare "Auto" token next to a concrete
  // time reads ambiguously, so omit it when the distance is left automatic.
  return s.intendedDistanceKm != null
    ? `${time} · ${formatDistance(s.intendedDistanceKm, unit)}`
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
  const lockFor = useSectionLock();
  const unit = useUnit();

  const routeLocked = session?.locks?.route ?? false;
  const runnersLocked = session?.locks?.runners ?? false;
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
              <Section title="The run" summary={runSummary(session, unit)} sectionKey="run" lock={lockFor("run")}>
                <RunSettings />
              </Section>
            )}

            {session && (
              <Section
                title="The route"
                summary={routeSummary(session)}
                sectionKey="route"
                defaultOpen={session.waypoints.length === 0 && !routeLocked}
                lock={lockFor("route")}
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
                lock={lockFor("runners")}
              >
                {runnersLocked && (
                  <p className="mb-3 text-xs text-fog">The runners are locked. Tap the lock above to make changes.</p>
                )}
                <ParticipantList />
                {!runnersLocked && (
                  <button
                    type="button"
                    onClick={openAddForm}
                    className="mt-3 w-full rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
                  >
                    + Join the flock
                  </button>
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
  const lockFor = useSectionLock();
  const unit = useUnit();

  const runnersLocked = session?.locks?.runners ?? false;
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
                <TabHeader title="The run" subtitle={runSummary(session, unit)} lock={lockFor("run")} />
                <RunSettings />
              </>
            )}

            {activeTab === "route" && (
              <>
                <TabHeader title="The route" subtitle={routeSummary(session)} lock={lockFor("route")} />
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
                  <TabHeader title="The runners" subtitle={runnersSummary(session)} lock={lockFor("runners")} />
                  {runnersLocked && (
                    <p className="mb-3 text-xs text-fog">The runners are locked. Tap the lock above to make changes.</p>
                  )}
                  <ParticipantList />
                  {!runnersLocked && (
                    <button
                      type="button"
                      onClick={openAddForm}
                      className="mt-3 w-full rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
                    >
                      + Join the flock
                    </button>
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

function TabHeader({
  title,
  subtitle,
  lock,
}: {
  title: string;
  subtitle: string;
  lock?: { locked: boolean; onToggle: () => void; label: string };
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex items-center gap-2">
        <span className="text-xs text-fog">{subtitle}</span>
        {lock && <LockToggle locked={lock.locked} onToggle={lock.onToggle} label={lock.label} />}
      </div>
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
