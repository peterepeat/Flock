"use client";

interface SliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  accent?: string;
}

/** Single-thumb slider with a value read-out. */
export default function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  accent = "var(--accent)",
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="select-none">
      <div className="relative h-9">
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-lift" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full"
          style={{ left: 0, width: `${pct}%`, background: accent }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute left-0 top-0 h-9 w-full appearance-none bg-transparent"
        />
      </div>
      <div className="mt-1 text-right">
        <span className="mono text-sm text-text">{format(value)}</span>
      </div>
    </div>
  );
}
