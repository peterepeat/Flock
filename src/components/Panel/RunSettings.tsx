"use client";

import { useRef, useState } from "react";

import Field from "@/components/ui/Field";
import Slider from "@/components/ui/Slider";
import Toggle from "@/components/ui/Toggle";
import { setRunConfig } from "@/lib/flockApi";
import type { TimeAnchor } from "@/lib/types";
import { DISTANCE_MAX_KM, DISTANCE_MIN_KM, formatDistance } from "@/lib/units";
import { useFlockStore, useUnit } from "@/store/flockStore";

/**
 * Run-level config (defaults, never mandatory): when the flock departs and how far the
 * run is. Both default to "auto" — 7:00 at the first waypoint, and the waypoint-tour
 * length (or 10 km). Setting them is optional; the engine works without either.
 */
type TimeMode = "auto" | "at" | "by";

export default function RunSettings() {
  const flockId = useFlockStore((s) => s.flockId);
  const session = useFlockStore((s) => s.session);
  const apply = useFlockStore((s) => s.applyServerSession);
  const openAddWaypoint = useFlockStore((s) => s.openAddWaypoint);
  const setSectionOpen = useFlockStore((s) => s.setSectionOpen);
  // Local: the user picked "Be there by" while there are no waypoints yet — there's no valid anchor to
  // SAVE (it needs a waypoint id), so we hold the choice locally until one exists + is picked. Cleared
  // the moment a waypoint anchor is saved (or another mode chosen).
  const [wantBy, setWantBy] = useState(false);
  const unit = useUnit();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Optimistic local overrides so the controls move INSTANTLY instead of waiting on the PATCH
  // round-trip (the controls otherwise render straight from server state). Distance is wrapped
  // so "set to Auto" (null) is distinguishable from "no override". Cleared once the server
  // session lands (or the write fails), so server state stays the single source of truth.
  const [draftAnchor, setDraftAnchor] = useState<TimeAnchor | null>(null);
  const [draftDistance, setDraftDistance] = useState<{ v: number | null } | null>(null);

  if (!session || !flockId) return null;
  const { waypoints } = session;
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

  const anchorTime = startAnchor.kind === "departure" || startAnchor.kind === "waypoint" ? startAnchor.time : "08:00";
  // The flock's time anchors ONE of: nothing (auto), the departure ("set off at"), or reaching a
  // waypoint ("be there by", back-timed). `wantBy` lets "be there by" stay selected while the user
  // goes off to add the waypoint it needs.
  const savedMode: TimeMode = startAnchor.kind === "auto" ? "auto" : startAnchor.kind === "waypoint" ? "by" : "at";
  const timeMode: TimeMode = wantBy ? "by" : savedMode;
  const wpTarget = startAnchor.kind === "waypoint" ? startAnchor.waypointId : waypoints[0]?.id ?? "";
  const setTimeMode = (m: TimeMode) => {
    if (m === "by" && waypoints.length === 0) { setWantBy(true); return; } // no waypoint to anchor yet
    setWantBy(false);
    save({ startAnchor: m === "auto" ? { kind: "auto" } : m === "at" ? { kind: "departure", time: anchorTime } : { kind: "waypoint", waypointId: wpTarget, time: anchorTime } });
  };
  const setTime = (time: string) =>
    save({ startAnchor: timeMode === "by" ? { kind: "waypoint", waypointId: wpTarget, time } : { kind: "departure", time } });
  const goAddWaypoint = () => { setSectionOpen("route", true); openAddWaypoint(); };

  const timeInput = (
    <input
      type="time"
      value={anchorTime}
      onChange={(e) => setTime(e.target.value)}
      className="mt-2 block rounded-lg border border-white/10 bg-surface-lift px-2 py-2 text-sm text-text outline-none focus:border-accent/60"
    />
  );

  return (
    <fieldset disabled={locked} className="m-0 space-y-4 border-0 p-0 disabled:opacity-60">
      {locked && (
        <p className="text-xs text-fog">The run is locked. Tap the lock above to make changes.</p>
      )}
      <Field label="Time">
        <Toggle
          options={[{ value: "auto", label: "Auto" }, { value: "at", label: "Set off at" }, { value: "by", label: "Be there by" }]}
          value={timeMode}
          onChange={(v) => setTimeMode(v as TimeMode)}
        />
        {timeMode === "at" && timeInput}
        {timeMode === "by" && (waypoints.length === 0 ? (
          <p className="mt-2 text-xs text-fog">
            You&apos;ll need a waypoint to aim for —{" "}
            <button type="button" onClick={goAddWaypoint} className="text-accent underline-offset-2 hover:underline">
              add one in The route
            </button>
            .
          </p>
        ) : (
          <>
            {timeInput}
            <select
              value={wpTarget}
              onChange={(e) => { setWantBy(false); save({ startAnchor: { kind: "waypoint", waypointId: e.target.value, time: anchorTime } }); }}
              className="mt-2 w-full rounded-lg border border-white/10 bg-surface-lift px-3 py-2.5 text-sm text-text outline-none focus:border-accent/60"
            >
              {waypoints.map((w, i) => (
                <option key={w.id} value={w.id}>{i + 1}. {w.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-fog">We work back everyone&apos;s departure so the flock reaches it by then.</p>
          </>
        ))}
      </Field>

      <Field label="Distance">
        <Toggle
          options={[{ value: "off", label: "Auto" }, { value: "on", label: "Set a distance" }]}
          value={distance != null ? "on" : "off"}
          onChange={(v) => save({ intendedDistanceKm: v === "on" ? 10 : null })}
        />
        {distance != null && (
          <div className="mt-2">
            <Slider min={DISTANCE_MIN_KM} max={DISTANCE_MAX_KM} value={distance} onChange={(v) => save({ intendedDistanceKm: v }, true)} format={(v) => formatDistance(v, unit)} />
            <p className="mt-1 text-xs text-fog">Otherwise we use the length of your waypoints (or 10 km).</p>
          </div>
        )}
      </Field>
    </fieldset>
  );
}
