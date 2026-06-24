"use client";

import type { ReactNode } from "react";

import LockToggle from "@/components/ui/LockToggle";
import { useFlockStore } from "@/store/flockStore";

/**
 * A collapsible config section ("concertina"). Collapsed, it shows a faded one-line
 * summary of the current settings; expanded, it reveals its controls. Open/closed state
 * lives in the store keyed by `sectionKey`, so it survives polling and the join form
 * opening/closing. Until the user toggles it, each section falls back to `defaultOpen`
 * (content-aware — e.g. open while a section is still empty/forming).
 *
 * `lock`, when given, renders an advisory section-lock padlock in the header (between
 * the title and the chevron). It's its own button, so the header is split into two
 * expand-buttons either side of the lock rather than one (no nested buttons).
 */
export default function Section({
  title,
  summary,
  sectionKey,
  defaultOpen = false,
  lock,
  children,
}: {
  title: string;
  summary: string;
  sectionKey: string;
  defaultOpen?: boolean;
  lock?: { locked: boolean; onToggle: () => void; label: string };
  children: ReactNode;
}) {
  const open = useFlockStore((s) => s.openSections[sectionKey] ?? defaultOpen);
  const setSectionOpen = useFlockStore((s) => s.setSectionOpen);
  const toggleOpen = () => setSectionOpen(sectionKey, !open);

  return (
    <div className="rounded-xl bg-surface">
      {/* Round the header's own corners (not overflow-hidden on the card) so an absolutely
          positioned child — e.g. the address-search dropdown in the waypoint editor — is
          never clipped by the section. */}
      <div className={`flex items-center pr-2 transition hover:bg-surface-lift/40 ${open ? "rounded-t-xl" : "rounded-xl"}`}>
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="text-sm font-medium text-text">{title}</span>
            {!open && summary && <span className="ml-2 text-xs text-fog">{summary}</span>}
          </span>
        </button>
        {lock && <LockToggle locked={lock.locked} onToggle={lock.onToggle} label={lock.label} className="mr-1" />}
        <button type="button" onClick={toggleOpen} aria-label={open ? "Collapse" : "Expand"} className="px-1.5 py-3">
          <Chevron open={open} />
        </button>
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 text-fog transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
