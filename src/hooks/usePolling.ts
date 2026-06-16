"use client";

import { useEffect, useRef } from "react";

import { createLogger } from "@/lib/logger";
import type { FlockSession } from "@/lib/types";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("polling");
const POLL_INTERVAL_MS = 5000;

/**
 * Polls GET /api/flocks/[id] every 5s and syncs the store. Updates only ripple
 * through when `updatedAt` actually changes (handled in applyServerSession), so
 * an open form draft is never clobbered by a poll.
 */
export function usePolling(flockId: string) {
  const applyServerSession = useFlockStore((s) => s.applyServerSession);
  const setStatus = useFlockStore((s) => s.setStatus);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll(reason: string) {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch(`/api/flocks/${flockId}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          log.warn("flock not found", { flockId });
          setStatus("notfound");
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const session = (await res.json()) as FlockSession;
        const changed = applyServerSession(session);
        if (changed) {
          log.debug("synced (changed)", {
            reason,
            updatedAt: session.updatedAt,
            participants: session.participants.length,
            locked: session.lockedAt != null,
          });
        }
      } catch (err) {
        if (!cancelled) log.error("poll failed", { flockId, error: String(err) });
      } finally {
        inFlight.current = false;
      }
    }

    log.info("polling started", { flockId, intervalMs: POLL_INTERVAL_MS });
    poll("initial");
    const timer = setInterval(() => poll("interval"), POLL_INTERVAL_MS);

    // Refresh promptly when the tab regains focus.
    const onVisible = () => {
      if (document.visibilityState === "visible") poll("visibility");
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      // Release the in-flight guard so a remount (React Strict Mode double-mount
      // in dev) can fire its own immediate poll instead of waiting a full cycle.
      inFlight.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      log.info("polling stopped", { flockId });
    };
  }, [flockId, applyServerSession, setStatus]);
}
