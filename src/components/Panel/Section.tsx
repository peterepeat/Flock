"use client";

import type { ReactNode } from "react";

import { useFlockStore } from "@/store/flockStore";

/**
 * A collapsible config section ("concertina"). Collapsed, it shows a faded one-line
 * summary of the current settings; expanded, it reveals its controls. Open/closed state
 * lives in the store keyed by `sectionKey`, so it survives polling and the join form
 * opening/closing. Until the user toggles it, each section falls back to `defaultOpen`
 * (content-aware — e.g. open while a section is still empty/forming).
 */
export default function Section({
  title,
  summary,
  sectionKey,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary: string;
  sectionKey: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const open = useFlockStore((s) => s.openSections[sectionKey] ?? defaultOpen);
  const setSectionOpen = useFlockStore((s) => s.setSectionOpen);

  return (
    <div className="rounded-xl bg-surface">
      {/* Round the header's own corners (not overflow-hidden on the card) so an absolutely
          positioned child — e.g. the address-search dropdown in the waypoint editor — is
          never clipped by the section. */}
      <button
        type="button"
        onClick={() => setSectionOpen(sectionKey, !open)}
        aria-expanded={open}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-lift/40 ${open ? "rounded-t-xl" : "rounded-xl"}`}
      >
        <span className="min-w-0 flex-1">
          <span className="text-sm font-medium text-text">{title}</span>
          {!open && summary && (
            <span className="ml-2 text-xs text-fog">{summary}</span>
          )}
        </span>
        <Chevron open={open} />
      </button>
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
