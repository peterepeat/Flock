"use client";

import { useEffect, useRef, useState } from "react";

import FlockSwitcher from "@/components/FlockSwitcher";
import { LockGlyph } from "@/components/ui/LockToggle";
import { lockFlock, unlockFlock } from "@/lib/flockApi";
import { flockDisplayName } from "@/lib/flockName";
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
  const toggleRef = useRef<HTMLButtonElement>(null);

  // The flock's name — set in The run, else auto-derived from the plan. Shown by the title and as the
  // browser tab / shared-link title, so a saved or shared flock reads as itself, not a bare slug.
  const flockName = session ? flockDisplayName(session) : "";
  useEffect(() => {
    document.title = flockName ? `${flockName} · Flock Party` : "Flock Party";
  }, [flockName]);

  // Pull the reader's saved km/mi choice from localStorage once on mount (client-only, so it can't run
  // during SSR and can't mismatch hydration — the first render uses the flock's unit until this lands).
  useEffect(() => {
    hydrateDisplayUnit();
  }, [hydrateDisplayUnit]);

  // "Lock the plan" = all three section locks set. (Per-runner locks are independent
  // and left alone by the global toggle, so a self-locked runner survives unlock.)
  // Locking is now also what STARTS Flock Party; unlocking ends it.
  const locks = session?.locks;
  const fullyLocked = !!locks && locks.run && locks.route && locks.runners;

  // When the party ends (locked → unlocked), put focus back on the toggle so a
  // keyboard user lands somewhere sensible rather than at the top of the page.
  const wasLocked = useRef(false);
  useEffect(() => {
    if (wasLocked.current && !fullyLocked) toggleRef.current?.focus();
    wasLocked.current = fullyLocked;
  }, [fullyLocked]);
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
    <header className="z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-white/5 bg-surface px-3 sm:gap-3 sm:px-4">
      <FlockSwitcher flockId={flockId} flockName={flockName} />

      <div className="flex items-center gap-1.5 sm:gap-2">
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
          aria-label={copied ? "Link copied" : "Copy link"}
          className="inline-flex items-center justify-center rounded-full border border-white/10 px-2.5 py-1.5 text-xs text-text transition hover:bg-surface-lift sm:px-3.5"
        >
          {/* Icon-only on mobile to save header room; full label on desktop. */}
          <span className="hidden sm:inline">{copied ? "Link copied ✓" : "Copy link"}</span>
          <span className="sm:hidden" aria-hidden="true">{copied ? "✓" : <LinkIcon />}</span>
        </button>
        {/* Locking the plan IS the party trigger — no separate button. Unlocked =
            "Start the party" (a quiet disco invite); locked = "Unlock to edit". */}
        <button
          type="button"
          ref={toggleRef}
          onClick={toggleLock}
          disabled={busy}
          aria-label={fullyLocked ? "Unlock to edit" : "Start the party"}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-60 sm:px-3.5 ${
            fullyLocked
              ? "border border-white/10 text-text hover:bg-surface-lift"
              : "bg-together text-[#0c1413] hover:brightness-110"
          }`}
        >
          {fullyLocked ? (
            <span className="text-accent">
              <LockGlyph locked={true} />
            </span>
          ) : (
            <span className="party-launch__ball text-sm leading-none" aria-hidden>
              🪩
            </span>
          )}
          {/* Label hidden on mobile — the glyph carries the state there. */}
          <span className="hidden sm:inline">{fullyLocked ? "Unlock to edit" : "Start the party"}</span>
        </button>
      </div>
    </header>
  );
}

// A small chain-link glyph — the mobile, icon-only form of "Copy link".
function LinkIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 14.5l5-5" />
      <path d="M11 6.5l1.2-1.2a3.6 3.6 0 0 1 5 5L17 11.5" />
      <path d="M13 17.5l-1.2 1.2a3.6 3.6 0 0 1-5-5L7 12.5" />
    </svg>
  );
}
