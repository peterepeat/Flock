"use client";

import { useEffect, useState } from "react";

import { lockFlock, unlockFlock } from "@/lib/flockApi";
import { createLogger } from "@/lib/logger";
import { useFlockStore } from "@/store/flockStore";

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
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const locked = session?.lockedAt != null;
  // No undo/redo on a locked plan (edits are rejected) or mid-flight.
  const canUndo = !locked && !historyBusy && undoStack.length > 0;
  const canRedo = !locked && !historyBusy && redoStack.length > 0;

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
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void undo()}
            disabled={!canUndo}
            title="Undo (⌘Z)"
            aria-label="Undo"
            className="flex h-8 w-8 items-center justify-center rounded-full text-base text-text transition hover:bg-surface-lift disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ⟲
          </button>
          <button
            type="button"
            onClick={() => void redo()}
            disabled={!canRedo}
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
            className="flex h-8 w-8 items-center justify-center rounded-full text-base text-text transition hover:bg-surface-lift disabled:opacity-30 disabled:hover:bg-transparent"
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
