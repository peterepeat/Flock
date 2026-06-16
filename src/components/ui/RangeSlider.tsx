"use client";

import { useCallback } from "react";

interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  /** Lower internal value (sits on the LEFT of the track). */
  low: number;
  /** Higher internal value (sits on the RIGHT of the track). */
  high: number;
  onChange: (low: number, high: number) => void;
  /** Render a value as a display string (handles unit conversion). */
  format: (value: number) => string;
  leftLabel?: string;
  rightLabel?: string;
  accent?: string; // track-fill colour
}

/**
 * Two-thumb slider built from two overlaid native range inputs (accessible,
 * keyboard-friendly). If the user drags the handles past each other the values
 * are swapped programmatically so `low` stays ≤ `high`.
 */
export default function RangeSlider({
  min,
  max,
  step = 1,
  low,
  high,
  onChange,
  format,
  leftLabel,
  rightLabel,
  accent = "var(--accent)",
}: RangeSliderProps) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  const handleLow = useCallback(
    (raw: number) => {
      const v = Math.min(raw, high);
      onChange(v, high);
    },
    [high, onChange],
  );

  const handleHigh = useCallback(
    (raw: number) => {
      const v = Math.max(raw, low);
      onChange(low, v);
    },
    [low, onChange],
  );

  return (
    <div className="select-none">
      <div className="relative h-9">
        {/* Base track */}
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-lift" />
        {/* Active fill */}
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full"
          style={{
            left: `${pct(low)}%`,
            width: `${Math.max(0, pct(high) - pct(low))}%`,
            background: accent,
          }}
        />
        {/* Low thumb */}
        <input
          type="range"
          aria-label={leftLabel || "minimum"}
          min={min}
          max={max}
          step={step}
          value={low}
          onChange={(e) => handleLow(Number(e.target.value))}
          className="pointer-events-none absolute left-0 top-0 h-9 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
          style={{ zIndex: low > max - (max - min) * 0.05 ? 5 : 3 }}
        />
        {/* High thumb */}
        <input
          type="range"
          aria-label={rightLabel || "maximum"}
          min={min}
          max={max}
          step={step}
          value={high}
          onChange={(e) => handleHigh(Number(e.target.value))}
          className="pointer-events-none absolute left-0 top-0 h-9 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
          style={{ zIndex: 4 }}
        />
      </div>

      <div className="mt-1 flex items-center justify-between">
        <span className="mono text-sm text-text">{format(low)}</span>
        <span className="mono text-sm text-text">{format(high)}</span>
      </div>
      {(leftLabel || rightLabel) && (
        <div className="mt-0.5 flex items-center justify-between text-[11px] uppercase tracking-wide text-fog">
          <span>{leftLabel}</span>
          <span>{rightLabel}</span>
        </div>
      )}
    </div>
  );
}
