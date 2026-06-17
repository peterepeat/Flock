"use client";

import { useCallback } from "react";

export type ThumbShape = "round" | "square" | "heart";

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
  /** Shape of the left / right thumb. Defaults to round. */
  leftThumb?: ThumbShape;
  rightThumb?: ThumbShape;
}

const THUMB_PX = 18;

/** A heart / square / round thumb glyph, drawn as a non-interactive overlay. */
function ThumbGlyph({ shape }: { shape: ThumbShape }) {
  if (shape === "heart") {
    return (
      <svg width={THUMB_PX} height={THUMB_PX} viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 20.3S3.6 15 3.6 9.1A4.1 4.1 0 0 1 12 6.6a4.1 4.1 0 0 1 8.4 2.5C20.4 15 12 20.3 12 20.3Z"
          fill="var(--text)"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const radius = shape === "square" ? "3px" : "50%";
  return (
    <span
      style={{
        display: "block",
        width: THUMB_PX - 2,
        height: THUMB_PX - 2,
        borderRadius: radius,
        background: "var(--text)",
        border: "2px solid var(--accent)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
      }}
    />
  );
}

/**
 * Two-thumb slider built from two overlaid native range inputs (accessible,
 * keyboard-friendly). If the user drags the handles past each other the values
 * are swapped programmatically so `low` stays ≤ `high`.
 *
 * When `leftThumb`/`rightThumb` are given a shape, the native thumbs are made
 * invisible (but still grabbable) and a matching glyph is drawn on top at the
 * exact thumb position — so a heart / square reads clearly without losing the
 * accessibility of native range inputs.
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
  leftThumb = "round",
  rightThumb = "round",
}: RangeSliderProps) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  // Centre of a native thumb: % along the track, corrected for the thumb inset
  // (its centre travels from THUMB/2 to width−THUMB/2, not 0→100%).
  const center = (v: number) => `calc(${pct(v)}% + ${(0.5 - pct(v) / 100) * THUMB_PX}px)`;
  const shaped = leftThumb !== "round" || rightThumb !== "round";

  const handleLow = useCallback(
    (raw: number) => onChange(Math.min(raw, high), high),
    [high, onChange],
  );
  const handleHigh = useCallback(
    (raw: number) => onChange(low, Math.max(raw, low)),
    [low, onChange],
  );

  return (
    <div className="select-none">
      <div className={`relative h-9 ${shaped ? "range-shaped" : ""}`}>
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
        {/* Shaped glyphs overlaid on the (now invisible) native thumbs */}
        {shaped && (
          <>
            <span
              className="pointer-events-none absolute top-1/2"
              style={{ left: center(low), transform: "translate(-50%, -50%)" }}
            >
              <ThumbGlyph shape={leftThumb} />
            </span>
            <span
              className="pointer-events-none absolute top-1/2"
              style={{ left: center(high), transform: "translate(-50%, -50%)" }}
            >
              <ThumbGlyph shape={rightThumb} />
            </span>
          </>
        )}
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
