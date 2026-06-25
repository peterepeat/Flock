"use client";

import { useEffect, useState } from "react";

import PartyLaunch from "@/components/Party/PartyLaunch";
import { LockGlyph } from "@/components/ui/LockToggle";
import { lockFlock, unlockFlock } from "@/lib/flockApi";
import { createLogger } from "@/lib/logger";
import type { Unit } from "@/lib/types";
import { useFlockStore, useUnit } from "@/store/flockStore";

const log = createLogger("header");

export default function Header() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const applyServerSession = useFlockStore((s) => s.applyServerSession);
  const undoStack = useFlockStore((s) => s.undoStack);
  const redoStack = useFlockStore((s) => s.redoStack);
  const historyBusy = useFlockStore((s) => s.historyBusy);
  const undo = useFlockStore((s) => s.undo);
  const redo = useFlockStore((s) => s.redo);
  const unit = useUnit();
  const setDisplayUnit = useFlockStore((s) => s.setDisplayUnit);
  const hydrateDisplayUnit = useFlockStore((s) => s.hydrateDisplayUnit);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // Pull the reader's saved km/mi choice from localStorage once on mount (client-only, so it can't run
  // during SSR and can't mismatch hydration — the first render uses the flock's unit until this lands).
  useEffect(() => {
    hydrateDisplayUnit();
  }, [hydrateDisplayUnit]);

  // "Lock the plan" = all three section locks set. (Per-runner locks are independent
  // and left alone by the global toggle, so a self-locked runner survives unlock.)
  const locks = session?.locks;
  const fullyLocked = !!locks && locks.run && locks.route && locks.runners;
  // No undo/redo when everything's locked (edits rejected) or mid-flight.
  const canUndo = !fullyLocked && !historyBusy && undoStack.length > 0;
  const canRedo = !fullyLocked && !historyBusy && redoStack.length > 0;

  // Keyboard: ⌘/Ctrl+Z = undo, ⇧⌘/Ctrl+Z or Ctrl+Y = redo. Skip while typing in a
  // field so native text undo still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const isUndo = k === "z" && !e.shiftKey;
      const isRedo = (k === "z" && e.shiftKey) || k === "y";
      if (!isUndo && !isRedo) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      if (isRedo) {
        if (canRedo) void redo();
      } else if (canUndo) {
        void undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canUndo, canRedo, undo, redo]);

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
    if (busy) return;
    setBusy(true);
    try {
      const updated = fullyLocked ? await unlockFlock(flockId) : await lockFlock(flockId);
      applyServerSession(updated, true);
      log.info(fullyLocked ? "unlocked" : "locked", { flockId });
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
        {/* Display unit — the reader's own km/mi preference (localStorage), not a flock setting. */}
        <div className="flex items-center rounded-full border border-white/10 p-0.5 text-xs" role="group" aria-label="Display units">
          {(["km", "miles"] as Unit[]).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setDisplayUnit(u)}
              aria-pressed={unit === u}
              className={`rounded-full px-2.5 py-1 transition ${unit === u ? "bg-surface-lift text-text" : "text-fog hover:text-text"}`}
            >
              {u === "km" ? "km" : "mi"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void undo()}
            disabled={!canUndo}
            title="Undo (⌘Z)"
            aria-label="Undo"
            className="flex h-9 w-9 items-center justify-center rounded-full text-2xl text-text transition hover:bg-surface-lift disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ⟲
          </button>
          <button
            type="button"
            onClick={() => void redo()}
            disabled={!canRedo}
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
            className="flex h-9 w-9 items-center justify-center rounded-full text-2xl text-text transition hover:bg-surface-lift disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ⟳
          </button>
        </div>
        <button
          type="button"
          onClick={copyLink}
          className="rounded-full border border-white/10 px-3.5 py-1.5 text-xs text-text transition hover:bg-surface-lift"
        >
          {copied ? "Link copied ✓" : "Copy link"}
        </button>
        <PartyLaunch />
        <button
          type="button"
          onClick={toggleLock}
          disabled={busy}
          className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition disabled:opacity-60 ${
            fullyLocked
              ? "border border-white/10 text-text hover:bg-surface-lift"
              : "bg-together text-[#0c1413] hover:brightness-110"
          }`}
        >
          <span className={fullyLocked ? "text-accent" : ""}>
            <LockGlyph locked={fullyLocked} />
          </span>
          {fullyLocked ? "Unlock to make changes" : "Lock the plan"}
        </button>
      </div>
    </header>
  );
}
