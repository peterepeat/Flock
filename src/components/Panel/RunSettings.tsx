"use client";

import { useRef, useState } from "react";

import Field from "@/components/ui/Field";
import Slider from "@/components/ui/Slider";
import Toggle from "@/components/ui/Toggle";
import { setRunConfig } from "@/lib/flockApi";
import type { TimeAnchor } from "@/lib/types";
import { DISTANCE_MAX_KM, DISTANCE_MIN_KM, formatDistance } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

/**
 * Run-level config (defaults, never mandatory): when the flock departs and how far the
 * run is. Both default to "auto" — 7:00 at the first waypoint, and the waypoint-tour
 * length (or 10 km). Setting them is optional; the engine works without either.
 */
export default function RunSettings() {
  const flockId = useFlockStore((s) => s.flockId);
  const session = useFlockStore((s) => s.session);
  const apply = useFlockStore((s) => s.applyServerSession);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Optimistic local overrides so the controls move INSTANTLY instead of waiting on the PATCH
  // round-trip (the controls otherwise render straight from server state). Distance is wrapped
  // so "set to Auto" (null) is distinguishable from "no override". Cleared once the server
  // session lands (or the write fails), so server state stays the single source of truth.
  const [draftAnchor, setDraftAnchor] = useState<TimeAnchor | null>(null);
  const [draftDistance, setDraftDistance] = useState<{ v: number | null } | null>(null);

  if (!session || !flockId) return null;
  const { waypoints, unitPreference } = session;
  const locked = session.locks?.run ?? false;
  const startAnchor = draftAnchor ?? session.startAnchor;
  const distance = draftDistance ? draftDistance.v : session.intendedDistanceKm;

  const save = (config: { startAnchor?: TimeAnchor; intendedDistanceKm?: number | null }, debounce = false) => {
    // Reflect the change immediately, then reconcile with the server in the background.
    if (config.startAnchor !== undefined) setDraftAnchor(config.startAnchor);
    if (config.intendedDistanceKm !== undefined) setDraftDistance({ v: config.intendedDistanceKm });
    const run = async () => {
      try {
        const s = await setRunConfig(flockId, config);
        apply(s, true);
      } catch {
        /* a transient failure — the next edit or poll reconciles */
      } finally {
        if (config.startAnchor !== undefined) setDraftAnchor(null);
        if (config.intendedDistanceKm !== undefined) setDraftDistance(null);
      }
    };
    if (timer.current) clearTimeout(timer.current);
    if (debounce) timer.current = setTimeout(run, 400);
    else void run();
  };

  const timeSet = startAnchor.kind !== "auto";
  const anchorTime = startAnchor.kind === "departure" || startAnchor.kind === "waypoint" ? startAnchor.time : "08:00";
  const anchorTarget = startAnchor.kind === "waypoint" ? startAnchor.waypointId : "departure";
  // The time can anchor EITHER the departure (when the first runner sets off) OR reaching a waypoint
  // ("be at the café by 9") — the engine back-times everyone's start for the latter. Reframe the
  // question around whichever the flock has chosen.
  const wpAnchor = startAnchor.kind === "waypoint";
  const setAnchor = (target: string, time: string) =>
    save({ startAnchor: target === "departure" ? { kind: "departure", time } : { kind: "waypoint", waypointId: target, time } });

  return (
    <fieldset disabled={locked} className="m-0 space-y-4 border-0 p-0 disabled:opacity-60">
      {locked && (
        <p className="text-xs text-fog">The run is locked. Tap the lock above to make changes.</p>
      )}
      <Field
        label={wpAnchor ? "When should the flock be there?" : "When does the run start?"}
        hint={wpAnchor ? "We work back everyone’s departure so the flock reaches it by then." : undefined}
      >
        <Toggle
          options={[{ value: "off", label: "Auto" }, { value: "on", label: "Set a time" }]}
          value={timeSet ? "on" : "off"}
          onChange={(v) => (v === "on" ? setAnchor("departure", anchorTime) : save({ startAnchor: { kind: "auto" } }))}
        />
        {timeSet && (
          <div className="mt-2 flex gap-2">
            {waypoints.length > 0 && (
              <select
                value={anchorTarget}
                onChange={(e) => setAnchor(e.target.value, anchorTime)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-lift px-2 py-2 text-xs text-text outline-none focus:border-accent/60"
              >
                <option value="departure">Set off at</option>
                {waypoints.map((w) => (
                  <option key={w.id} value={w.id}>Be at {w.name} by</option>
                ))}
              </select>
            )}
            <input
              type="time"
              value={anchorTime}
              onChange={(e) => setAnchor(anchorTarget, e.target.value)}
              className="rounded-lg border border-white/10 bg-surface-lift px-2 py-2 text-sm text-text outline-none focus:border-accent/60"
            />
          </div>
        )}
      </Field>

      <Field label="How far is the run?" optional>
        <Toggle
          options={[{ value: "off", label: "Auto" }, { value: "on", label: "Set a distance" }]}
          value={distance != null ? "on" : "off"}
          onChange={(v) => save({ intendedDistanceKm: v === "on" ? 10 : null })}
        />
        {distance != null && (
          <div className="mt-2">
            <Slider min={DISTANCE_MIN_KM} max={DISTANCE_MAX_KM} value={distance} onChange={(v) => save({ intendedDistanceKm: v }, true)} format={(v) => formatDistance(v, unitPreference)} />
            <p className="mt-1 text-xs text-fog">Otherwise we use the length of your waypoints (or 10 km).</p>
          </div>
        )}
      </Field>
    </fieldset>
  );
}
