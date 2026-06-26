"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import Header from "@/components/Header";
import FlockMap from "@/components/Map/FlockMap";
import FlockPanel from "@/components/Panel/FlockPanel";
import MobileTabBar from "@/components/Panel/MobileTabBar";
import { usePolling } from "@/hooks/usePolling";
import { useRouteCalculation } from "@/hooks/useRouteCalculation";
import { flockDisplayName } from "@/lib/flockName";
import { pushRecentFlock, syncRecentRunners } from "@/lib/recentStore";
import { useFlockStore } from "@/store/flockStore";

export default function FlockClient({ flockId }: { flockId: string }) {
  const setFlockId = useFlockStore((s) => s.setFlockId);
  const status = useFlockStore((s) => s.status);
  const calcStatus = useFlockStore((s) => s.calcStatus);
  const hasSession = useFlockStore((s) => s.session != null);
  const setActiveTab = useFlockStore((s) => s.setActiveTab);
  const participants = useFlockStore((s) => s.session?.participants);
  const flockName = useFlockStore((s) => (s.session ? flockDisplayName(s.session) : null));
  const initialTabSet = useRef(false);

  useEffect(() => {
    setFlockId(flockId);
  }, [flockId, setFlockId]);

  // Keep YOUR cached runners current: when anyone edits a runner whose name you've saved, refresh
  // the local copy so they carry the latest prefs into your next flock. (No-op until you've saved one.)
  useEffect(() => {
    if (participants) syncRecentRunners(participants);
  }, [participants]);

  // Remember this flock (id + current name) for the homepage "jump back in" list + the header switcher.
  useEffect(() => {
    if (flockName != null) pushRecentFlock(flockId, flockName);
  }, [flockId, flockName]);

  // Pick the opening mobile tab once the flock loads: an empty flock starts on Run (the first
  // authoring step); an already-populated one (a joiner via the shared link) starts on Map so
  // they see the plan first. Desktop ignores activeTab. Runs once per flock load.
  useEffect(() => {
    if (initialTabSet.current || !hasSession) return;
    initialTabSet.current = true;
    const s = useFlockStore.getState().session!;
    if (s.participants.length > 0 || s.waypoints.length > 0) setActiveTab("map");
  }, [hasSession, setActiveTab]);

  usePolling(flockId);
  useRouteCalculation(flockId);

  if (status === "notfound") {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-semibold">This flock link has expired or doesn’t exist.</h1>
        <Link
          href="/"
          className="mt-6 rounded-full bg-accent px-6 py-3 text-sm font-medium text-white hover:brightness-110"
        >
          Start a new flock
        </Link>
      </main>
    );
  }

  if (status === "loading") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center">
        <span className="text-sm text-fog">Working out your routes…</span>
      </main>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <Header />
      <div className="relative flex flex-1 overflow-hidden">
        <FlockPanel />
        <div className="relative h-full flex-1">
          <FlockMap />
          {/* Calculation status banner (top-centre of the map). */}
          {calcStatus !== "idle" && (
            <div
              className={`pointer-events-none absolute left-1/2 top-4 z-[600] -translate-x-1/2 rounded-full px-4 py-2 text-xs shadow-panel backdrop-blur ${
                calcStatus === "error"
                  ? "bg-accent/90 text-white"
                  : "bg-surface-mid/90 text-text-dim"
              }`}
            >
              {calcStatus === "working"
                ? "Working out your routes…"
                : "Routes are taking longer than usual — trying again shortly."}
            </div>
          )}
        </div>
      </div>
      <MobileTabBar />
    </div>
  );
}
