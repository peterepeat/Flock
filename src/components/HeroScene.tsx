"use client";

import { useMemo } from "react";

// A playful, map-less illustration of the Flock Party idea: runners set off from
// different places, converge on a shared loop, grab a coffee, and circle it together
// — forever, like the screensaver. Pure SVG; dancers ride the real route paths via
// <animateMotion>. Rendered client-only (ssr:false) so the per-load variety is safe.

const PALETTE = ["#E8855A", "#6A5AE0", "#D4A847", "#8B6FC4", "#4A8FC4", "#C44A7A"];

// The shared loop the flock runs together (the empty middle frames the headline).
const LOOP =
  "M600 130C800 130 960 230 960 360C960 490 800 590 600 590C400 590 240 490 240 360C240 230 400 130 600 130Z";
// Feeder legs — different starts converging on the loop's meet point (240,360).
const FEEDERS = [
  { id: "f1", d: "M70 80C150 175 195 280 240 360", from: [70, 80] },
  { id: "f2", d: "M95 660C155 545 200 450 240 360", from: [95, 660] },
  { id: "f3", d: "M30 320C110 335 180 350 240 360", from: [30, 320] },
];
// One runner peels off the loop to their own finish.
const PEEL = { id: "peel", d: "M960 360C1035 415 1085 485 1135 565", to: [1135, 565] };

// Static dots placed around the loop for the reduced-motion fallback.
const STATIC_DOTS: [number, number][] = [
  [770, 165],
  [930, 430],
  [470, 575],
  [300, 235],
  [615, 588],
];

const rand = (min: number, max: number) => min + Math.random() * (max - min);
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function HeroScene() {
  const reduce =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const { loopDancers, legDancers, sparkles, colors } = useMemo(() => {
    const colors = shuffle(PALETTE);
    const n = Math.round(rand(4, 6));
    const loopDancers = Array.from({ length: n }, (_, i) => ({
      color: colors[i % colors.length],
      dur: rand(13, 19),
      begin: -rand(0, 19),
    }));
    const legDancers = [
      ...FEEDERS.map((f, i) => ({ path: f.id, color: colors[i % colors.length], dur: rand(5.5, 8.5), begin: -rand(0, 8) })),
      { path: PEEL.id, color: colors[3], dur: rand(6, 9), begin: -rand(0, 9) },
    ];
    const sparkles = Array.from({ length: 7 }, () => ({
      x: rand(60, 1140),
      y: rand(60, 660),
      delay: rand(0, 4),
      dur: rand(3.5, 6),
    }));
    return { loopDancers, legDancers, sparkles, colors };
  }, []);

  return (
    <svg className="hero-scene" viewBox="0 0 1200 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {/* together-glow under the shared loop */}
      <path d={LOOP} className="hero-glow hero-glow--together" />

      {/* feeder + peel routes (glow casing, then colour) */}
      {FEEDERS.map((f, i) => (
        <g key={f.id}>
          <path d={f.d} className="hero-glow" style={{ stroke: colors[i] }} />
          <path id={f.id} d={f.d} className="hero-route" pathLength={1} style={{ stroke: colors[i], animationDelay: `${0.2 + i * 0.15}s` }} />
        </g>
      ))}
      <path d={PEEL.d} className="hero-glow" style={{ stroke: colors[3] }} />
      <path id={PEEL.id} d={PEEL.d} className="hero-route" pathLength={1} style={{ stroke: colors[3], animationDelay: "0.7s" }} />

      {/* the shared loop itself */}
      <path id="loop" d={LOOP} className="hero-route hero-route--loop" pathLength={1} style={{ animationDelay: "0.1s" }} />

      {/* starts, finish flag, coffee stop, meet glow */}
      {FEEDERS.map((f, i) => (
        <circle key={`s${i}`} cx={f.from[0]} cy={f.from[1]} r={5.5} fill={colors[i]} stroke="#fff" strokeWidth={1.3} />
      ))}
      <circle cx={240} cy={360} r={9} className="hero-meet">
        {!reduce && <animate attributeName="r" values="7;12;7" dur="2.6s" repeatCount="indefinite" />}
        {!reduce && <animate attributeName="opacity" values="0.55;0.95;0.55" dur="2.6s" repeatCount="indefinite" />}
      </circle>
      <text x={600} y={140} className="hero-emoji" textAnchor="middle">☕</text>
      <text x={PEEL.to[0]} y={PEEL.to[1] + 4} className="hero-emoji" textAnchor="middle">🏁</text>

      {/* the flock — dancers circling the loop together (forever, like the screensaver) */}
      {reduce
        ? STATIC_DOTS.map(([x, y], i) => (
            <g key={`sd${i}`} transform={`translate(${x} ${y})`}>
              <circle r={13} fill={colors[i % colors.length]} opacity={0.25} />
              <circle r={6} fill={colors[i % colors.length]} stroke="#fff" strokeWidth={1.4} />
            </g>
          ))
        : loopDancers.map((d, i) => (
            <g key={`ld${i}`}>
              <circle r={13} fill={d.color} opacity={0.25} />
              <circle r={6} fill={d.color} stroke="#fff" strokeWidth={1.4} />
              <animateMotion dur={`${d.dur}s`} begin={`${d.begin}s`} repeatCount="indefinite">
                <mpath xlinkHref="#loop" />
              </animateMotion>
            </g>
          ))}

      {/* dancers arriving along the feeders + the one peeling off */}
      {!reduce &&
        legDancers.map((d, i) => (
          <g key={`fd${i}`}>
            <circle r={11} fill={d.color} opacity={0.25} />
            <circle r={5} fill={d.color} stroke="#fff" strokeWidth={1.2} />
            <animateMotion dur={`${d.dur}s`} begin={`${d.begin}s`} repeatCount="indefinite">
              <mpath xlinkHref={`#${d.path}`} />
            </animateMotion>
          </g>
        ))}

      {/* disco sparkle */}
      {!reduce &&
        sparkles.map((s, i) => (
          <text key={`sp${i}`} x={s.x} y={s.y} className="hero-sparkle" style={{ animationDelay: `${s.delay}s`, animationDuration: `${s.dur}s` }}>
            ✨
          </text>
        ))}
    </svg>
  );
}
