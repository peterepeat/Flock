"use client";

import Link from "next/link";
import { useEffect } from "react";

import Header from "@/components/Header";
import FlockMap from "@/components/Map/FlockMap";
import FlockPanel from "@/components/Panel/FlockPanel";
import { usePolling } from "@/hooks/usePolling";
import { useRouteCalculation } from "@/hooks/useRouteCalculation";
import { useFlockStore } from "@/store/flockStore";

export default function FlockClient({ flockId }: { flockId: string }) {
  const setFlockId = useFlockStore((s) => s.setFlockId);
  const status = useFlockStore((s) => s.status);
  const calcStatus = useFlockStore((s) => s.calcStatus);

  useEffect(() => {
    setFlockId(flockId);
  }, [flockId, setFlockId]);

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
    </div>
  );
}
