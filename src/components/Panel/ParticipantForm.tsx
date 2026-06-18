"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import AddressSearch from "@/components/ui/AddressSearch";
import Field from "@/components/ui/Field";
import RangeSlider from "@/components/ui/RangeSlider";
import Slider from "@/components/ui/Slider";
import Toggle from "@/components/ui/Toggle";
import {
  addParticipant,
  FlockApiError,
  removeParticipant,
  setUnit,
  updateParticipant,
} from "@/lib/flockApi";
import { createLogger } from "@/lib/logger";
import type { LatLng, ParticipantConstraints, Unit } from "@/lib/types";
import {
  DISTANCE_MAX_KM,
  DISTANCE_MIN_KM,
  DISTANCE_TARGET_BAND,
  formatDistance,
  formatPace,
  PACE_MAX_SEC_PER_KM,
  PACE_MIN_SEC_PER_KM,
  secToTime,
  timeToSec,
} from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("participant-form");

// Time-of-day window for the "time constraints" slider (minutes since midnight).
const TIME_MIN = 4 * 60; // 04:00
const TIME_MAX = 22 * 60; // 22:00
const TIME_STEP = 15;
const toMin = (t: string | null, fallback: number) => (t ? Math.round(timeToSec(t) / 60) : fallback);

interface Draft {
  name: string;
  startLocation: LatLng | null;
  startAddress: string;
  finishMode: "start" | "elsewhere";
  finishLocation: LatLng | null;
  finishAddress: string | null;
  distanceOn: boolean;
  distanceKm: number; // single "how far" target
  paceOn: boolean;
  paceSec: number; // single comfortable pace (sec/km)
  timeOn: boolean;
  earliestMin: number; // can't leave before (minutes since midnight)
  latestMin: number; // must be done by
}

function emptyDraft(): Draft {
  return {
    name: "",
    startLocation: null,
    startAddress: "",
    finishMode: "start",
    finishLocation: null,
    finishAddress: null,
    distanceOn: false,
    distanceKm: 8,
    paceOn: false,
    paceSec: 360, // 6:00 /km — a comfortable default
    timeOn: false,
    earliestMin: 7 * 60, // 07:00
    latestMin: 10 * 60, // 10:00
  };
}

export default function ParticipantForm() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const editingId = useFlockStore((s) => s.editingParticipantId);
  const closeForm = useFlockStore((s) => s.closeForm);
  const applyServerSession = useFlockStore((s) => s.applyServerSession);
  const placingPin = useFlockStore((s) => s.placingPin);
  const setPlacingPin = useFlockStore((s) => s.setPlacingPin);
  const draftStart = useFlockStore((s) => s.draftStart);
  const setDraftStart = useFlockStore((s) => s.setDraftStart);
  const setPendingStart = useFlockStore((s) => s.setPendingStart);
  const placingFinish = useFlockStore((s) => s.placingFinish);
  const setPlacingFinish = useFlockStore((s) => s.setPlacingFinish);
  const draftFinish = useFlockStore((s) => s.draftFinish);
  const setDraftFinish = useFlockStore((s) => s.setDraftFinish);
  const setPendingFinish = useFlockStore((s) => s.setPendingFinish);

  const unit: Unit = session?.unitPreference ?? "km";
  const isFirstParticipant = (session?.participants.length ?? 0) === 0 && !editingId;

  const existing = useMemo(
    () => session?.participants.find((p) => p.id === editingId) ?? null,
    [session, editingId],
  );

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [targetId, setTargetId] = useState<string | null>(editingId);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const initialised = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the draft from an existing participant (edit mode) once.
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    if (existing) {
      setTargetId(existing.id);
      setDraft({
        name: existing.name,
        startLocation: existing.startLocation,
        startAddress: existing.startAddress,
        finishMode: existing.finishLocation ? "elsewhere" : "start",
        finishLocation: existing.finishLocation,
        finishAddress: existing.finishAddress,
        distanceOn: existing.preferredDistance != null,
        distanceKm: existing.preferredDistance ?? 8,
        paceOn: existing.preferredPace != null,
        paceSec: existing.preferredPace ?? 360,
        timeOn: existing.earliestStartTime != null || existing.latestFinishTime != null,
        earliestMin: toMin(existing.earliestStartTime, 7 * 60),
        latestMin: toMin(existing.latestFinishTime, 10 * 60),
      });
    }
  }, [existing]);

  // Publish the draft's start / finish to the map so the pins show live.
  useEffect(() => {
    setPendingStart(draft.startLocation);
  }, [draft.startLocation, setPendingStart]);
  useEffect(() => {
    setPendingFinish(draft.finishMode === "elsewhere" ? draft.finishLocation : null);
  }, [draft.finishMode, draft.finishLocation, setPendingFinish]);

  // Fold a map-dropped start pin into the draft.
  useEffect(() => {
    if (draftStart) {
      setDraft((d) => ({ ...d, startLocation: draftStart, startAddress: d.startAddress || "Dropped pin" }));
      setPlacingPin(false);
      setDraftStart(null);
      log.debug("start pin dropped", { draftStart });
    }
  }, [draftStart, setPlacingPin, setDraftStart]);

  // Fold a map-dropped finish pin into the draft.
  useEffect(() => {
    if (draftFinish) {
      setDraft((d) => ({
        ...d,
        finishMode: "elsewhere",
        finishLocation: draftFinish,
        finishAddress: d.finishAddress || "Dropped pin",
      }));
      setPlacingFinish(false);
      setDraftFinish(null);
      log.debug("finish pin dropped", { draftFinish });
    }
  }, [draftFinish, setPlacingFinish, setDraftFinish]);

  function buildConstraints(d: Draft): ParticipantConstraints | null {
    if (!d.name.trim() || !d.startLocation) return null;
    return {
      name: d.name.trim(),
      startLocation: d.startLocation,
      startAddress: d.startAddress || "Dropped pin",
      earliestStartTime: d.timeOn ? secToTime(d.earliestMin * 60) : null,
      finishLocation: d.finishMode === "elsewhere" ? d.finishLocation : null,
      finishAddress: d.finishMode === "elsewhere" ? d.finishAddress : null,
      latestFinishTime: d.timeOn ? secToTime(d.latestMin * 60) : null,
      // One stated pace → the engine's only pace input. maxPace is unused by the
      // engine (the flock runs at the slowest present preferred pace), so it's null.
      preferredPace: d.paceOn ? d.paceSec : null,
      maxPace: null,
      // One stated distance → the engine's target. maxDistance is handed a small
      // headroom band so the stated number reads as "about this far" (a target to
      // centre on), not a hard ceiling. See DISTANCE_TARGET_BAND in units.ts.
      preferredDistance: d.distanceOn ? d.distanceKm : null,
      maxDistance: d.distanceOn ? Math.round(d.distanceKm * (1 + DISTANCE_TARGET_BAND) * 10) / 10 : null,
      restStop: null, // stops are now shared waypoints, set by the flock
    };
  }

  const constraints = buildConstraints(draft);
  const canSave = constraints != null;

  // Auto-save (edit mode only): debounce 500ms after the last change.
  useEffect(() => {
    if (!targetId) return; // creation uses the explicit button
    if (!constraints) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await updateParticipant(flockId, targetId, constraints);
        applyServerSession(updated, true);
        setSaveState("saved");
        log.debug("autosaved", { targetId });
      } catch (err) {
        setSaveState("error");
        setErrorMsg(err instanceof FlockApiError ? err.message : "Could not save");
        log.error("autosave failed", { targetId, error: String(err) });
      }
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(constraints), targetId]);

  async function handleCreate() {
    if (!constraints) return;
    setSaveState("saving");
    setErrorMsg(null);
    try {
      const { session: updated, participantId } = await addParticipant(flockId, constraints);
      applyServerSession(updated, true);
      setTargetId(participantId);
      setSaveState("saved");
      log.info("created participant", { participantId });
      closeForm();
    } catch (err) {
      setSaveState("error");
      setErrorMsg(err instanceof FlockApiError ? err.message : "Could not save your details");
      log.error("create failed", { error: String(err) });
    }
  }

  async function handleRemove() {
    if (!targetId) return;
    try {
      const updated = await removeParticipant(flockId, targetId);
      applyServerSession(updated, true);
      log.info("left the flock", { targetId });
      closeForm();
    } catch (err) {
      setErrorMsg(err instanceof FlockApiError ? err.message : "Could not remove");
    }
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // Start / finish pin placement are mutually exclusive map modes.
  const toggleStartPin = () => {
    setPlacingFinish(false);
    setPlacingPin(!placingPin);
  };
  const toggleFinishPin = () => {
    setPlacingPin(false);
    setPlacingFinish(!placingFinish);
  };

  return (
    <div className="space-y-6">
      {/* Units (first participant sets it for everyone) */}
      <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2">
        <span className="text-xs text-text-dim">This flock is using</span>
        {isFirstParticipant ? (
          <Toggle<Unit>
            options={[
              { value: "km", label: "km" },
              { value: "miles", label: "miles" },
            ]}
            value={unit}
            onChange={async (u) => {
              try {
                const updated = await setUnit(flockId, u);
                applyServerSession(updated, true);
              } catch (err) {
                log.error("set unit failed", { error: String(err) });
              }
            }}
          />
        ) : (
          <span className="mono text-sm text-text">{unit}</span>
        )}
      </div>

      {/* Name */}
      <Field label="What should we call you?">
        <input
          type="text"
          value={draft.name}
          placeholder="What should we call you?"
          onChange={(e) => set("name", e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-surface-lift px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-accent/60"
        />
      </Field>

      {/* Start */}
      <Field label="Where are you starting from?">
        <AddressSearch
          initialValue={draft.startAddress === "Dropped pin" ? "" : draft.startAddress}
          placeholder="Search for your starting point"
          onSelect={(r) => {
            set("startLocation", { lat: r.lat, lng: r.lng });
            set("startAddress", r.shortName);
          }}
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={toggleStartPin}
            className={`text-xs ${placingPin ? "text-accent" : "text-fog hover:text-text"}`}
          >
            {placingPin ? "Tap the map to drop your pin…" : "…or tap the map to drop a pin"}
          </button>
          {draft.startLocation && (
            <span className="mono text-xs text-together">
              ✓ {draft.startLocation.lat.toFixed(4)}, {draft.startLocation.lng.toFixed(4)}
            </span>
          )}
        </div>
      </Field>

      {/* Finish — right below start */}
      <Field label="Where are you finishing?">
        <Toggle
          options={[
            { value: "start", label: "Back where I started" },
            { value: "elsewhere", label: "Somewhere else" },
          ]}
          value={draft.finishMode}
          onChange={(v) => set("finishMode", v as "start" | "elsewhere")}
        />
        {draft.finishMode === "elsewhere" && (
          <div className="mt-3">
            <AddressSearch
              initialValue={draft.finishAddress === "Dropped pin" ? "" : draft.finishAddress ?? ""}
              placeholder="Where are you finishing?"
              onSelect={(r) => {
                set("finishLocation", { lat: r.lat, lng: r.lng });
                set("finishAddress", r.shortName);
              }}
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={toggleFinishPin}
                className={`text-xs ${placingFinish ? "text-accent" : "text-fog hover:text-text"}`}
              >
                {placingFinish ? "Tap the map to drop your pin…" : "…or tap the map to drop a pin"}
              </button>
              {draft.finishLocation && (
                <span className="mono text-xs text-together">
                  ✓ {draft.finishLocation.lat.toFixed(4)}, {draft.finishLocation.lng.toFixed(4)}
                </span>
              )}
            </div>
          </div>
        )}
      </Field>

      {/* Distance — a single target the flock centres your run on, not a hard cap. */}
      <Field label="How far do you want to run?" optional>
        <Toggle
          options={[
            { value: "off", label: "No preference" },
            { value: "on", label: "Set a distance" },
          ]}
          value={draft.distanceOn ? "on" : "off"}
          onChange={(v) => set("distanceOn", v === "on")}
        />
        {draft.distanceOn && (
          <div className="mt-3">
            <Slider
              min={DISTANCE_MIN_KM}
              max={DISTANCE_MAX_KM}
              value={draft.distanceKm}
              onChange={(v) => set("distanceKm", v)}
              format={(v) => formatDistance(v, unit)}
            />
            <p className="mt-1 text-xs text-fog">Roughly this far — we’ll get you close.</p>
          </div>
        )}
      </Field>

      {/* Pace — a single comfortable pace; the flock runs at the slowest one present. */}
      <Field label="How fast do you run?" optional>
        <Toggle
          options={[
            { value: "off", label: "No preference" },
            { value: "on", label: "Set a pace" },
          ]}
          value={draft.paceOn ? "on" : "off"}
          onChange={(v) => set("paceOn", v === "on")}
        />
        {draft.paceOn && (
          <div className="mt-3">
            <Slider
              min={PACE_MIN_SEC_PER_KM}
              max={PACE_MAX_SEC_PER_KM}
              step={5}
              value={draft.paceSec}
              onChange={(v) => set("paceSec", v)}
              format={(v) => formatPace(v, unit)}
            />
            <p className="mt-1 text-xs text-fog">Your comfortable pace — the flock keeps to its slowest.</p>
          </div>
        )}
      </Field>

      {/* Time constraints */}
      <Field label="What are your time constraints?" optional>
        <Toggle
          options={[
            { value: "off", label: "No preference" },
            { value: "on", label: "Set a range" },
          ]}
          value={draft.timeOn ? "on" : "off"}
          onChange={(v) => set("timeOn", v === "on")}
        />
        {draft.timeOn && (
          <div className="mt-3">
            <RangeSlider
              min={TIME_MIN}
              max={TIME_MAX}
              step={TIME_STEP}
              low={draft.earliestMin}
              high={draft.latestMin}
              onChange={(low, high) => {
                set("earliestMin", low);
                set("latestMin", high);
              }}
              format={(m) => secToTime(m * 60)}
              leftThumb="square"
              rightThumb="square"
              leftLabel="Can't leave before"
              rightLabel="Must be done by"
            />
          </div>
        )}
      </Field>

      {errorMsg && <p className="text-sm text-accent">{errorMsg}</p>}

      {/* Footer actions */}
      <div className="sticky bottom-0 -mx-5 flex items-center justify-between gap-3 border-t border-white/5 bg-surface-mid px-5 pb-1 pt-4">
        {targetId ? (
          <>
            <span className="text-xs text-fog">
              {saveState === "saving" && "Saving…"}
              {saveState === "saved" && "Saved ✓"}
              {saveState === "error" && "Couldn’t save"}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleRemove}
                className="text-xs text-fog hover:text-accent"
              >
                Leave the flock
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={closeForm}
              className="text-sm text-fog hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave || saveState === "saving"}
              onClick={handleCreate}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveState === "saving" ? "Saving…" : "Save my details"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
