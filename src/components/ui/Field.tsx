"use client";

import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}

/** Consistent label + optional hint wrapper for form rows. */
export default function Field({ label, hint, optional, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-sm font-medium text-text">{label}</label>
        {optional && <span className="text-[11px] uppercase tracking-wide text-fog">optional</span>}
      </div>
      {children}
      {hint && <p className="text-xs leading-relaxed text-text-dim">{hint}</p>}
    </div>
  );
}
