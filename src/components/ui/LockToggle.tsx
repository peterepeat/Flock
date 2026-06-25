"use client";

/**
 * The universal "advisory lock" affordance — used on each section header and each
 * runner row. Locks are a shared SIGNAL anyone can flip (the URL is the real access
 * boundary), so the control always looks openable: a tinted closed padlock when
 * locked, a faded open one when not.
 */
export default function LockToggle({
  locked,
  onToggle,
  label,
  className = "",
}: {
  locked: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={locked}
      aria-label={label}
      title={label}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition ${
        locked ? "text-accent hover:bg-accent/15" : "text-fog hover:bg-surface-lift hover:text-text"
      } ${className}`}
    >
      <LockGlyph locked={locked} />
    </button>
  );
}

/** The bare padlock glyph (closed when locked, open when not) — `currentColor`, so the caller
 * tints it: accent/orange when locked, faded when open. Shared by the section/runner toggles and
 * the global "Lock the plan" button so the lock state reads the same everywhere. */
export function LockGlyph({ locked }: { locked: boolean }) {
  return locked ? <ClosedLock /> : <OpenLock />;
}

function ClosedLock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.4" rx="1.3" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function OpenLock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.4" rx="1.3" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.1-0.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
