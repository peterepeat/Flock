"use client";

import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}

/** Consistent label + optional hint wrapper for form rows. */
export default function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-text">{label}</label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-text-dim">{hint}</p>}
    </div>
  );
}
