"use client";

import { useEffect, useRef } from "react";

import { createLogger } from "@/lib/logger";
import type { CalcWarning } from "@/lib/routing-types";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("route-calc");
const DEBOUNCE_MS = 2000;
const MAX_ATTEMPTS = 4; // initial try + this many retries before giving up
const backoffMs = (attempt: number) => Math.min(3000 * 2 ** attempt, 30000);
const fmtTime = (epochSec: number) =>
  new Date(epochSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Watches the session and, whenever routes are stale (computedRoutes === null)
 * and at least one participant has a start, debounces 2s and asks the server to
 * (re)calculate. The server persists the result; every polling client then picks
 * the routes up.
 *
 * A transient failure (a 500, network blip, ORS burst limit) now SELF-HEALS:
 * the same session version is retried with exponential backoff instead of
 * stalling until something changes. A daily-quota 429 is terminal — we surface
 * "resets ~HH:MM" and stop hammering until the next edit.
 */
export function useRouteCalculation(flockId: string) {
  const session = useFlockStore((s) => s.session);
  const setCalcStatus = useFlockStore((s) => s.setCalcStatus);
  const setCalcWarnings = useFlockStore((s) => s.setCalcWarnings);
  const setCalcError = useFlockStore((s) => s.setCalcError);

  const triggeredForUpdatedAt = useRef<string | null>(null);
  const inFlight = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updatedAt = session?.updatedAt ?? null;
  const routesPresent = session?.computedRoutes != null;
  const withStart = session?.participants.length ?? 0;

  useEffect(() => {
    const clearRetry = () => {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };

    if (!session) return;
    if (routesPresent) {
      setCalcStatus("idle");
      setCalcError(null);
      clearRetry();
      return;
    }
    if (withStart < 1) return;
    if (triggeredForUpdatedAt.current === updatedAt) return; // already running/handled this version
    if (inFlight.current) return;

    triggeredForUpdatedAt.current = updatedAt;
    let attempt = 0;

    const runCalc = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setCalcStatus("working");
      const done = log.time("trigger-calculate", { flockId, updatedAt, attempt });
      let retry = false;
      try {
        const res = await fetch("/api/routes/calculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flockId }),
        });
        if (res.status === 429) {
          const data = (await res.json().catch(() => ({}))) as { code?: string; resetAt?: number };
          if (data?.code === "quota") {
            const when = data.resetAt ? fmtTime(data.resetAt) : null;
            setCalcError(
              when
                ? `Daily routing limit reached — routes will work again after ~${when}.`
                : "Daily routing limit reached — routes will work again once it resets.",
            );
            setCalcStatus("error");
            done({ quota: true });
            return; // terminal until the next edit
          }
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as {
          warnings: CalcWarning[];
          routeCount: number;
          sharedCount: number;
          persisted?: boolean; // false = computed but NOT saved (plan changed under us)
          skipped?: boolean;
        };
        setCalcWarnings(data.warnings ?? []);
        setCalcError(null);
        if (data.persisted === false && !data.skipped) {
          // The server computed routes but the plan kept changing while it ran, so
          // nothing was saved (routes stay null). Retry with backoff until editing
          // settles — otherwise we'd go idle and strand the user with no route.
          log.debug("calc not persisted (plan still churning) — retrying", { attempt });
          if (attempt < MAX_ATTEMPTS) {
            setCalcStatus("working");
            retry = true;
          } else {
            setCalcError("Routes kept shifting while calculating — change anything to retry.");
            setCalcStatus("idle");
          }
        } else {
          setCalcStatus("idle");
        }
        done({ routes: data.routeCount, shared: data.sharedCount, warnings: data.warnings?.length, persisted: data.persisted });
      } catch (err) {
        log.error("calculation failed", { flockId, attempt, error: String(err) });
        setCalcStatus("error");
        done({ error: true, attempt });
        if (attempt < MAX_ATTEMPTS) {
          retry = true;
        } else {
          setCalcError("Couldn't work out routes after a few tries — change anything to retry.");
        }
      } finally {
        inFlight.current = false;
      }
      if (retry) {
        const delay = backoffMs(attempt);
        attempt += 1;
        log.debug("retrying calculation", { flockId, attempt, delay });
        retryTimer.current = setTimeout(runCalc, delay);
      }
    };

    const jitter = Math.floor(Math.random() * 800);
    log.debug("scheduling calculation", { updatedAt, withStart, debounceMs: DEBOUNCE_MS + jitter });
    const first = setTimeout(runCalc, DEBOUNCE_MS + jitter);

    return () => {
      clearTimeout(first);
      clearRetry();
    };
  }, [session, updatedAt, routesPresent, withStart, flockId, setCalcStatus, setCalcWarnings, setCalcError]);
}
