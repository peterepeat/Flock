"use client";

import { useState } from "react";

import { lockFlock, unlockFlock } from "@/lib/flockApi";
import { createLogger } from "@/lib/logger";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("header");

export default function Header() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const applyServerSession = useFlockStore((s) => s.applyServerSession);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const locked = session?.lockedAt != null;

  async function copyLink() {
    const url =
      typeof window !== "undefined"
        ? window.location.href
        : `${process.env.NEXT_PUBLIC_APP_URL}/flock/${flockId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      log.debug("link copied", { url });
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      log.error("copy failed", { error: String(err) });
    }
  }

  async function toggleLock() {
    setBusy(true);
    try {
      const updated = locked ? await unlockFlock(flockId) : await lockFlock(flockId);
      applyServerSession(updated, true);
      log.info(locked ? "unlocked" : "locked", { flockId });
    } catch (err) {
      log.error("lock toggle failed", { error: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/5 bg-surface px-4">
      <div className="flex items-center gap-3">
        <span className="text-base font-semibold tracking-tight">Flock</span>
        <span className="mono hidden text-xs text-fog sm:inline">flock/{flockId}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={copyLink}
          className="rounded-full border border-white/10 px-3.5 py-1.5 text-xs text-text transition hover:bg-surface-lift"
        >
          {copied ? "Link copied ✓" : "Copy link"}
        </button>
        <button
          type="button"
          onClick={toggleLock}
          disabled={busy}
          className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition disabled:opacity-60 ${
            locked
              ? "border border-white/10 text-text hover:bg-surface-lift"
              : "bg-together text-[#0c1413] hover:brightness-110"
          }`}
        >
          {locked ? "Unlock to make changes" : "Lock the plan"}
        </button>
      </div>
    </header>
  );
}
