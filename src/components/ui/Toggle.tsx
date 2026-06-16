"use client";

interface ToggleProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Segmented two-or-more-way toggle. */
export default function Toggle<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: ToggleProps<T>) {
  return (
    <div
      className={`inline-flex rounded-full bg-surface p-1 ${disabled ? "opacity-50" : ""}`}
      role="group"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              active
                ? "bg-surface-lift text-text shadow-sm"
                : "text-text-dim hover:text-text"
            } ${disabled ? "cursor-not-allowed" : ""}`}
            aria-pressed={active}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
