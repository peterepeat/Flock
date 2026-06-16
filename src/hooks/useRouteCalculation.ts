"use client";

import { useEffect, useRef } from "react";

import { createLogger } from "@/lib/logger";
import type { CalcWarning } from "@/lib/routing-types";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("route-calc");
const DEBOUNCE_MS = 2000;

/**
 * Watches the session and, whenever routes are stale (computedRoutes === null)
 * and at least one participant has a start, debounces 2s and asks the server to
 * (re)calculate. The server persists the result; every polling client then picks
 * the routes up. Guards prevent duplicate firing for the same session version.
 *
 * All clients run this; a per-updatedAt guard + small jitter keep redundant ORS
 * calls down (and the server caches identical ORS requests within a warm
 * instance). This is intentionally simple and heavily logged so the trigger
 * behaviour is easy to observe and tune.
 */
export function useRouteCalculation(flockId: string) {
  const session = useFlockStore((s) => s.session);
  const setCalcStatus = useFlockStore((s) => s.setCalcStatus);
  const setCalcWarnings = useFlockStore((s) => s.setCalcWarnings);

  const triggeredForUpdatedAt = useRef<string | null>(null);
  const inFlight = useRef(false);

  const updatedAt = session?.updatedAt ?? null;
  const routesPresent = session?.computedRoutes != null;
  const withStart = session?.participants.filter((p) => p.startLocation).length ?? 0;

  useEffect(() => {
    if (!session) return;

    if (routesPresent) {
      setCalcStatus("idle");
      return;
    }
    if (withStart < 1) return;
    if (triggeredForUpdatedAt.current === updatedAt) return;
    if (inFlight.current) return;

    const jitter = Math.floor(Math.random() * 800);
    log.debug("scheduling calculation", { updatedAt, withStart, debounceMs: DEBOUNCE_MS + jitter });

    const timer = setTimeout(async () => {
      triggeredForUpdatedAt.current = updatedAt;
      inFlight.current = true;
      setCalcStatus("working");
      const done = log.time("trigger-calculate", { flockId, updatedAt });
      try {
        const res = await fetch("/api/routes/calculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flockId }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as {
          warnings: CalcWarning[];
          routeCount: number;
          sharedCount: number;
        };
        setCalcWarnings(data.warnings ?? []);
        setCalcStatus("idle");
        done({ routes: data.routeCount, shared: data.sharedCount, warnings: data.warnings?.length });
      } catch (err) {
        log.error("calculation failed", { flockId, error: String(err) });
        setCalcStatus("error");
        done({ error: true });
        // Allow a retry on a later poll after a short cool-off.
        setTimeout(() => {
          triggeredForUpdatedAt.current = null;
        }, 8000);
      } finally {
        inFlight.current = false;
      }
    }, DEBOUNCE_MS + jitter);

    return () => clearTimeout(timer);
  }, [session, updatedAt, routesPresent, withStart, flockId, setCalcStatus, setCalcWarnings]);
}
