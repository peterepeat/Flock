"use client";

import L from "leaflet";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMap } from "react-leaflet";

import { initial } from "@/lib/colors";
import { buildPartySim, flockGroups, type PartyFlag, type PartySim, type RunnerFrame } from "@/lib/party/simulate";
import type { ComputedRoute, Participant } from "@/lib/types";
import { secToTime } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";
import { usePartyStore } from "@/store/partyStore";

import { dancerFor, phraseFor } from "./phrases";

// The whole run compresses into this many real seconds at 1× — lively, not a slideshow.
const BASE_DURATION_S = 26;
const SPEEDS = [0.5, 1, 2, 4];
const DEFAULT_SPEED_IDX = 1; // 1×
const BUBBLE_MS = 2400; // how long a speech bubble lingers (real ms)
const READOUT_MS = 80; // throttle for the React clock/scrubber/mode re-render (~12Hz)

// ---------------------------------------------------------------------------
// Controller — mounts the stage while the party is active. Re-mounts fresh each
// time (so the clock and all refs reset cleanly on every open).
// ---------------------------------------------------------------------------
export default function PartyController() {
  const active = usePartyStore((s) => s.active);
  return active ? <PartyStage /> : null;
}

function PartyStage() {
  const map = useMap();
  const close = usePartyStore((s) => s.close);

  // Freeze the plan at open — the show is a replay; a live edit mid-playback
  // shouldn't yank the dancers around. Reads the store imperatively, once.
  const snap = useState(() => {
    const s = useFlockStore.getState().session;
    const routes = (s?.computedRoutes ?? []) as ComputedRoute[];
    const sim = s
      ? buildPartySim({ participants: s.participants, routes, sharedSegments: s.sharedSegments ?? [] })
      : null;
    return { sim, routes, participants: s?.participants ?? [] };
  })[0];

  // A dedicated overlay layer appended INSIDE the Leaflet container, so everything
  // is clipped to the map and tracks its pan/zoom. Toggles a `party-on` class for
  // the disco backdrop. Fully torn down on close.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "party-layer";
    const container = map.getContainer();
    container.appendChild(el);
    container.classList.add("party-on");
    setLayer(el);
    return () => {
      container.classList.remove("party-on");
      el.remove();
      setLayer(null);
    };
  }, [map]);

  // Nothing playable (shouldn't happen — the launch button gates it — but never strand the user).
  useEffect(() => {
    if (!snap.sim) close();
  }, [snap.sim, close]);

  // Frame the whole show once on open.
  useEffect(() => {
    if (!snap.sim) return;
    const pts: L.LatLngExpression[] = [];
    for (const r of snap.routes) for (const [lng, lat] of r.geometry.coordinates) pts.push([lat, lng]);
    if (pts.length >= 2) {
      try {
        map.fitBounds(L.latLngBounds(pts).pad(0.08), { animate: true, maxZoom: 16 });
      } catch {
        /* a degenerate bounds — leave the view as-is */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  if (!layer || !snap.sim) return null;
  return createPortal(
    <Stage sim={snap.sim} participants={snap.participants} map={map} onClose={close} />,
    layer,
  );
}

// ---------------------------------------------------------------------------
// The stage — avatars, flags, bubbles, fireworks, and the transport bar.
// ---------------------------------------------------------------------------
interface Bubble {
  evId: string;
  text: string;
  born: number; // performance.now() when it appeared
}

// What we draw at one map point: a single runner, or a merged "flock together" group.
type Entity =
  | { kind: "solo"; key: string; id: string }
  | { kind: "group"; key: string; ids: string[]; lead: string };

function Stage({
  sim,
  participants,
  map,
  onClose,
}: {
  sim: PartySim;
  participants: Participant[];
  map: L.Map;
  onClose: () => void;
}) {
  // Stable (memo on the frozen sim) so positionAll / the rAF loop never churn.
  const dancers = useMemo(() => sim.tracks.filter((t) => !t.parked), [sim]);
  const colorById = useMemo(() => {
    const m: Record<string, string> = {};
    participants.forEach((p) => (m[p.id] = p.color));
    return m;
  }, [participants]);
  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    participants.forEach((p) => (m[p.id] = p.name));
    return m;
  }, [participants]);
  const avatarIndex = useMemo(() => {
    const m: Record<string, number> = {};
    participants.forEach((p, i) => (m[p.id] = i));
    return m;
  }, [participants]);

  // --- React state (low-frequency): readout, transient effects ---
  const [clockSec, setClockSec] = useState(sim.tStart);
  const [playing, setPlaying] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(DEFAULT_SPEED_IDX);
  const [bubbles, setBubbles] = useState<Record<string, Bubble>>({});
  const [shownFlags, setShownFlags] = useState<Set<string>>(new Set());
  const [finale, setFinale] = useState(false);

  // --- refs (per-frame, no re-render) ---
  const clockRef = useRef(sim.tStart);
  const playingRef = useRef(true);
  const speedRef = useRef(DEFAULT_SPEED_IDX);
  const evPtrRef = useRef(0);
  const lastTickRef = useRef(0);
  const lastReadoutRef = useRef(0);
  const rafRef = useRef(0);
  const avatarRefs = useRef(new Map<string, HTMLDivElement>());
  const flagRefs = useRef(new Map<string, HTMLDivElement>());
  const bubblesRef = useRef(bubbles);
  bubblesRef.current = bubbles;

  // Avatar nodes are keyed by ENTITY (a solo runner, or a merged flock-together
  // group), which changes as runners meet/part. Cache a stable ref callback per
  // key so 12Hz re-renders don't churn refs; entitiesRef holds the live set the
  // imperative loop positions.
  const avatarRefCache = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const refFor = (key: string) => {
    const cache = avatarRefCache.current;
    let cb = cache.get(key);
    if (!cb) {
      cb = (el) => (el ? avatarRefs.current.set(key, el) : avatarRefs.current.delete(key));
      cache.set(key, cb);
    }
    return cb;
  };
  const entitiesRef = useRef<Entity[]>([]);
  const flagRefCb = useMemo(() => {
    const m: Record<string, (el: HTMLDivElement | null) => void> = {};
    for (const f of sim.flags)
      m[f.id] = (el) => (el ? flagRefs.current.set(f.id, el) : flagRefs.current.delete(f.id));
    return m;
  }, [sim.flags]);

  // Cluster runners flocking together at `sec` into entities + carry each runner's
  // frame (for state/glyph in the render).
  const groupAt = useMemo(
    () => (sec: number): { entities: Entity[]; frames: Record<string, RunnerFrame> } => {
      const frames: Record<string, RunnerFrame> = {};
      const companions: Record<string, string[]> = {};
      for (const t of dancers) {
        const f = t.frameAt(sec);
        frames[t.id] = f;
        companions[t.id] = f.companions;
      }
      const entities = flockGroups(companions).map((ids): Entity =>
        ids.length >= 2
          ? { kind: "group", key: "g:" + ids.join("|"), ids, lead: ids[0] }
          : { kind: "solo", key: "s:" + ids[0], id: ids[0] },
      );
      return { entities, frames };
    },
    [dancers],
  );

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    speedRef.current = speedIdx;
  }, [speedIdx]);

  // Place every avatar + flag at the current clock (imperative — runs every frame
  // so the show tracks any pan/zoom too). A group sits on its lead runner (members
  // coincide). Uses the last-rendered entity set so node keys match.
  const positionAll = useMemo(
    () => (sec: number) => {
      for (const e of entitiesRef.current) {
        const el = avatarRefs.current.get(e.key);
        if (!el) continue;
        const lead = sim.byId[e.kind === "group" ? e.lead : e.id];
        if (!lead) continue;
        const { pos } = lead.frameAt(sec);
        const p = map.latLngToContainerPoint([pos.lat, pos.lng]);
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      }
      for (const f of sim.flags) {
        const el = flagRefs.current.get(f.id);
        if (!el) continue;
        const p = map.latLngToContainerPoint([f.location.lat, f.location.lng]);
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      }
    },
    [sim, map],
  );

  // Place everyone before each paint, so a freshly-mounted node (incl. a group that
  // just formed) never flashes at the map's corner. Runs after every render; cheap.
  useLayoutEffect(() => {
    positionAll(clockRef.current);
  });

  // Fire any events whose time we've just crossed (forward play only).
  const fireUpTo = useMemo(
    () => (sec: number, now: number) => {
      const evs = sim.events;
      let fired: Record<string, Bubble> | null = null;
      while (evPtrRef.current < evs.length && evs[evPtrRef.current].t <= sec) {
        const ev = evs[evPtrRef.current++];
        const targets = ev.kind === "meet" ? ev.subjectIds : [...ev.subjectIds, ...ev.withIds];
        for (const id of targets) {
          (fired ??= {})[id] = { evId: ev.id, text: phraseFor(ev.kind, ev.id), born: now };
        }
      }
      if (fired) setBubbles((prev) => ({ ...prev, ...fired }));
    },
    [sim.events],
  );

  // Which flags are planted at clock `c` (planted, not yet folded up).
  const flagsShownAt = useMemo(
    () => (c: number) => {
      const want = new Set<string>();
      for (const f of sim.flags) if (f.plantedAt <= c && (f.removeAt == null || c < f.removeAt)) want.add(f.id);
      return want;
    },
    [sim.flags],
  );

  // Jump the clock (scrubbing / restart): silently skip past events at/under the
  // target so a seek never spams bubbles, then fully reconcile the visual state.
  const seek = useMemo(
    () => (sec: number) => {
      const c = Math.max(sim.tStart, Math.min(sim.tEnd, sec));
      clockRef.current = c;
      let ptr = 0;
      while (ptr < sim.events.length && sim.events[ptr].t <= c) ptr++;
      evPtrRef.current = ptr;
      setBubbles({});
      setFinale(c >= sim.tEnd);
      setShownFlags((prev) => {
        const want = flagsShownAt(c);
        return sameSet(prev, want) ? prev : want;
      });
      setClockSec(c);
      positionAll(c);
    },
    [sim, positionAll, flagsShownAt],
  );

  // The single animation loop.
  useEffect(() => {
    lastTickRef.current = performance.now();
    const span = sim.tEnd - sim.tStart;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTickRef.current) / 1000); // clamp tab-switch jumps
      lastTickRef.current = now;
      // Only do work while actually playing — when paused/finished the clock is
      // frozen, so per-frame repositioning + state writes are pure waste. A paused
      // frame still tracks the map via the move/zoom listener below, not the loop.
      if (playingRef.current) {
        const simPerReal = (span / BASE_DURATION_S) * SPEEDS[speedRef.current];
        let c = clockRef.current + dt * simPerReal;
        if (c >= sim.tEnd) {
          c = sim.tEnd;
          playingRef.current = false;
          setPlaying(false);
          setFinale(true);
        }
        clockRef.current = c;
        fireUpTo(c, now);
        positionAll(c);
        if (now - lastReadoutRef.current > READOUT_MS) {
          lastReadoutRef.current = now;
          setClockSec(c);
          // expire stale bubbles
          const cur = bubblesRef.current;
          let changed = false;
          const next: Record<string, Bubble> = {};
          for (const [id, b] of Object.entries(cur)) {
            if (now - b.born < BUBBLE_MS) next[id] = b;
            else changed = true;
          }
          if (changed) setBubbles(next);
          // recompute which flags are planted right now
          const want = flagsShownAt(c);
          setShownFlags((prev) => (sameSet(prev, want) ? prev : want));
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [sim, positionAll, fireUpTo, flagsShownAt]);

  // Keep avatars/flags pinned to the map when it pans/zooms while PAUSED (the rAF
  // loop only repositions during playback). Harmless (redundant) during playback.
  useEffect(() => {
    const reposition = () => positionAll(clockRef.current);
    map.on("move zoom resize", reposition);
    return () => {
      map.off("move zoom resize", reposition);
    };
  }, [map, positionAll]);

  // Keyboard: space = play/pause, Esc = exit. The overlay is intentionally
  // non-blocking (the app behind stays reachable), so ignore keystrokes that
  // belong to a focused text field — never hijack a space or eat an Esc there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move focus onto the transport on open so keyboard / screen-reader users land
  // on the controls (PartyLaunch restores focus to itself on close).
  const playBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    playBtnRef.current?.focus();
  }, []);

  function pause() {
    playingRef.current = false;
    setPlaying(false);
  }
  function togglePlay() {
    if (clockRef.current >= sim.tEnd) {
      seek(sim.tStart);
      playingRef.current = true;
      setPlaying(true);
      return;
    }
    const next = !playingRef.current;
    playingRef.current = next;
    setPlaying(next);
  }
  function restart() {
    seek(sim.tStart);
    setFinale(false);
    playingRef.current = true;
    setPlaying(true);
  }
  function cycleSpeed() {
    setSpeedIdx((i) => (i + 1) % SPEEDS.length);
  }

  const done = clockSec >= sim.tEnd;
  const progress = (clockSec - sim.tStart) / Math.max(1, sim.tEnd - sim.tStart);

  // Current entities (solo runners + merged flock groups) for this readout tick.
  const { entities, frames } = groupAt(clockSec);
  entitiesRef.current = entities;

  return (
    <>
      {/* Cancel — top-left, the spot the launch button used to occupy. */}
      <button
        type="button"
        onClick={onClose}
        className="party-cancel pointer-events-auto"
        aria-label="Exit Flock Party"
        title="Exit Flock Party (Esc)"
      >
        <span aria-hidden="true" className="party-cancel__x">
          ✕
        </span>
        <span className="party-cancel__label">Exit party</span>
      </button>

      {/* avatars — a solo dancer, or one merged "flock together" group */}
      {entities.map((e) =>
        e.kind === "group" ? (
          <GroupAvatar
            key={e.key}
            frame={frames[e.lead]}
            count={e.ids.length}
            bubble={e.ids.map((id) => bubbles[id]?.text).find(Boolean)}
            anchorRef={refFor(e.key)}
          />
        ) : (
          <Avatar
            key={e.key}
            frame={frames[e.id]}
            color={colorById[e.id] ?? "#888"}
            name={nameById[e.id] ?? "Runner"}
            dancer={dancerFor(avatarIndex[e.id] ?? 0)}
            bubble={bubbles[e.id]?.text}
            anchorRef={refFor(e.key)}
          />
        ),
      )}

      {/* flags */}
      {sim.flags.map((f) => (
        <Flag key={f.id} flag={f} shown={shownFlags.has(f.id)} anchorRef={flagRefCb[f.id]} />
      ))}

      {/* fireworks finale */}
      {finale && <Fireworks />}

      {/* transport bar */}
      <div className="party-controls pointer-events-auto">
        <div className="party-controls__inner" role="group" aria-label="Flock Party playback">
          <button type="button" onClick={restart} className="party-btn" aria-label="Rewind to start" title="Rewind to start">
            ⏮
          </button>
          <button
            type="button"
            ref={playBtnRef}
            onClick={togglePlay}
            className="party-btn party-btn--primary"
            aria-label={done ? "Replay" : playing ? "Pause" : "Play"}
            title={playing ? "Pause (space)" : "Play (space)"}
          >
            {done ? "↺" : playing ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            onClick={cycleSpeed}
            className="party-btn party-btn--speed"
            aria-label={`Playback speed ${SPEEDS[speedIdx]}×, tap to change`}
            title="Playback speed"
          >
            {SPEEDS[speedIdx]}×
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onPointerDown={pause}
            onKeyDown={(e) => {
              // Keyboard scrubbing: pause first, else the running clock overwrites the nudge.
              if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key === "PageUp" || e.key === "PageDown") pause();
            }}
            onChange={(e) => seek(sim.tStart + (Number(e.target.value) / 1000) * (sim.tEnd - sim.tStart))}
            className="party-scrub"
            aria-label="Scrub through the run"
            aria-valuetext={secToTime(clockSec)}
          />
          <span className="party-clock mono">{secToTime(clockSec)}</span>
        </div>
      </div>

      {/* finale banner */}
      {finale && (
        <div className="party-finale-banner pointer-events-none">
          <span>🎆 The flock is done &amp; dusted! 🎆</span>
        </div>
      )}
    </>
  );
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------
function Avatar({
  frame,
  color,
  name,
  dancer,
  bubble,
  anchorRef,
}: {
  frame: RunnerFrame;
  color: string;
  name: string;
  dancer: string;
  bubble?: string;
  anchorRef: (el: HTMLDivElement | null) => void;
}) {
  const { state, headingDeg, moving } = frame;
  // Face the direction of travel (flip when heading west).
  const facingLeft = headingDeg > 180;
  const glyph =
    state === "resting" ? "☕" : state === "finished" ? "🎉" : dancer;
  return (
    <div ref={anchorRef} className="party-anchor" data-state={state}>
      <div
        className={`party-avatar party-avatar--${state}${moving ? " is-moving" : ""}`}
        style={{ "--p-color": color } as CSSProperties}
      >
        {bubble && <div className="party-bubble">{bubble}</div>}
        <div className="party-avatar__disc">
          <span className="party-avatar__glyph" style={{ transform: facingLeft ? "scaleX(-1)" : undefined }}>
            {glyph}
          </span>
          <span className="party-avatar__badge">{initial(name)}</span>
        </div>
        <div className="party-avatar__name mono">{name}</div>
      </div>
    </div>
  );
}

// Several runners flocking together collapse into ONE distinct avatar: a rainbow
// disco disc, a "crowd" glyph (☕ at a stop), the head-count, and a "Flock ×N"
// tag — so an overlap reads as a group, not a single runner hiding the rest.
function GroupAvatar({
  frame,
  count,
  bubble,
  anchorRef,
}: {
  frame: RunnerFrame;
  count: number;
  bubble?: string;
  anchorRef: (el: HTMLDivElement | null) => void;
}) {
  const { state, moving } = frame;
  const glyph = state === "resting" ? "☕" : "👯";
  return (
    <div ref={anchorRef} className="party-anchor" data-state={state}>
      <div className={`party-avatar party-group party-avatar--${state}${moving ? " is-moving" : ""}`}>
        {bubble && <div className="party-bubble">{bubble}</div>}
        <div className="party-avatar__disc party-group__disc">
          <span className="party-avatar__glyph">{glyph}</span>
          <span className="party-avatar__badge party-group__badge">{count}</span>
        </div>
        <div className="party-avatar__name mono">Flock ×{count}</div>
      </div>
    </div>
  );
}

function Flag({
  flag,
  shown,
  anchorRef,
}: {
  flag: PartyFlag;
  shown: boolean;
  anchorRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div ref={anchorRef} className="party-anchor" style={{ visibility: shown ? "visible" : "hidden" }}>
      <div className={`party-flag party-flag--${flag.kind}${shown ? " is-planted" : ""}`}>
        <span className="party-flag__cloth">{flag.kind === "stop" ? "☕" : "🏁"}</span>
        <span className="party-flag__pole" />
      </div>
    </div>
  );
}

// A burst of CSS fireworks across the map for the finale.
function Fireworks() {
  const bursts = [
    { left: "22%", top: "32%", delay: "0s", hue: "var(--accent)" },
    { left: "70%", top: "28%", delay: "0.35s", hue: "var(--together)" },
    { left: "48%", top: "20%", delay: "0.7s", hue: "#ffd54a" },
    { left: "32%", top: "52%", delay: "1.05s", hue: "#ff79c6" },
    { left: "78%", top: "55%", delay: "1.4s", hue: "#8be9fd" },
    { left: "58%", top: "40%", delay: "1.75s", hue: "#a6ff8b" },
  ];
  return (
    <div className="party-fireworks pointer-events-none">
      {bursts.map((b, i) => (
        <span
          key={i}
          className="party-firework"
          style={{ left: b.left, top: b.top, animationDelay: b.delay, "--fw": b.hue } as CSSProperties}
        >
          {Array.from({ length: 12 }).map((_, j) => (
            <i key={j} style={{ "--a": `${j * 30}deg` } as CSSProperties} />
          ))}
        </span>
      ))}
    </div>
  );
}
