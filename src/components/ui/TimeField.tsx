"use client";

interface TimeFieldProps {
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
}

/** A native time input that can be cleared back to null ("any time"). */
export default function TimeField({ value, onChange }: TimeFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="time"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="mono rounded-lg border border-white/10 bg-surface-lift px-3 py-2 text-sm text-text outline-none focus:border-accent/60 [color-scheme:dark]"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-fog hover:text-text"
        >
          clear
        </button>
      )}
    </div>
  );
}
