"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import AddressSearch from "@/components/ui/AddressSearch";
import Field from "@/components/ui/Field";
import RangeSlider from "@/components/ui/RangeSlider";
import Slider from "@/components/ui/Slider";
import TimeField from "@/components/ui/TimeField";
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
  formatDistance,
  formatPace,
  PACE_MAX_SEC_PER_KM,
  PACE_MIN_SEC_PER_KM,
} from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("participant-form");

interface Draft {
  name: string;
  startLocation: LatLng | null;
  startAddress: string;
  earliestStartTime: string | null;
  finishMode: "start" | "elsewhere";
  finishLocation: LatLng | null;
  finishAddress: string | null;
  latestFinishTime: string | null;
  distanceOn: boolean;
  preferredDistance: number;
  maxDistance: number;
  paceOn: boolean;
  maxPace: number; // faster (lower sec/km)
  preferredPace: number; // slower (higher sec/km)
  restOn: boolean;
  restDuration: number;
  restLocationMode: "anywhere" | "specific";
  restLocation: LatLng | null;
  restLocationAddress: string | null;
}

function emptyDraft(): Draft {
  return {
    name: "",
    startLocation: null,
    startAddress: "",
    earliestStartTime: "07:00",
    finishMode: "start",
    finishLocation: null,
    finishAddress: null,
    latestFinishTime: null,
    distanceOn: false,
    preferredDistance: 8,
    maxDistance: 12,
    paceOn: false,
    maxPace: 300, // 5:00 /km
    preferredPace: 360, // 6:00 /km
    restOn: false,
    restDuration: 30,
    restLocationMode: "anywhere",
    restLocation: null,
    restLocationAddress: null,
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

  const unit: Unit = session?.unitPreference ?? "km";
  const isFirstParticipant = (session?.participants.length ?? 0) === 0 && !editingId;

  const existing = useMemo(
    () => session?.participants.find((p) => p.id === editingId) ?? null,
    [session, editingId],
  );

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [showMore, setShowMore] = useState(false);
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
      setShowMore(true);
      setDraft({
        name: existing.name,
        startLocation: existing.startLocation,
        startAddress: existing.startAddress,
        earliestStartTime: existing.earliestStartTime,
        finishMode: existing.finishLocation ? "elsewhere" : "start",
        finishLocation: existing.finishLocation,
        finishAddress: existing.finishAddress,
        latestFinishTime: existing.latestFinishTime,
        distanceOn: existing.preferredDistance != null,
        preferredDistance: existing.preferredDistance ?? 8,
        maxDistance: existing.maxDistance ?? existing.preferredDistance ?? 12,
        paceOn: existing.preferredPace != null,
        maxPace: existing.maxPace ?? 300,
        preferredPace: existing.preferredPace ?? 360,
        restOn: existing.restStop?.wantsStop ?? false,
        restDuration: existing.restStop?.durationMinutes ?? 30,
        restLocationMode: existing.restStop?.location ? "specific" : "anywhere",
        restLocation: existing.restStop?.location ?? null,
        restLocationAddress: existing.restStop?.locationAddress ?? null,
      });
    }
  }, [existing]);

  // Publish the draft's start to the map so the in-progress pin shows live.
  useEffect(() => {
    setPendingStart(draft.startLocation);
  }, [draft.startLocation, setPendingStart]);

  // When a start pin is dropped on the map, fold it into the draft.
  useEffect(() => {
    if (draftStart) {
      setDraft((d) => ({
        ...d,
        startLocation: draftStart,
        startAddress: d.startAddress || "Dropped pin",
      }));
      setPlacingPin(false);
      setDraftStart(null);
      log.debug("start pin dropped", { draftStart });
    }
  }, [draftStart, setPlacingPin, setDraftStart]);

  function buildConstraints(d: Draft): ParticipantConstraints | null {
    if (!d.name.trim() || !d.startLocation) return null;
    return {
      name: d.name.trim(),
      startLocation: d.startLocation,
      startAddress: d.startAddress || "Dropped pin",
      earliestStartTime: d.earliestStartTime,
      finishLocation: d.finishMode === "elsewhere" ? d.finishLocation : null,
      finishAddress: d.finishMode === "elsewhere" ? d.finishAddress : null,
      latestFinishTime: d.latestFinishTime,
      preferredPace: d.paceOn ? d.preferredPace : null,
      maxPace: d.paceOn ? d.maxPace : null,
      preferredDistance: d.distanceOn ? d.preferredDistance : null,
      maxDistance: d.distanceOn ? d.maxDistance : null,
      restStop: d.restOn
        ? {
            wantsStop: true,
            durationMinutes: d.restDuration,
            location: d.restLocationMode === "specific" ? d.restLocation : null,
            locationAddress: d.restLocationMode === "specific" ? d.restLocationAddress : null,
          }
        : null,
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
            onClick={() => setPlacingPin(!placingPin)}
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

      {!showMore && (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          className="text-sm text-accent hover:brightness-110"
        >
          + Add more details
        </button>
      )}

      {showMore && (
        <div className="space-y-6 border-t border-white/5 pt-6">
          {/* Earliest start */}
          <Field label="Earliest you can leave" optional>
            <TimeField
              value={draft.earliestStartTime}
              onChange={(v) => set("earliestStartTime", v)}
            />
          </Field>

          {/* Distance */}
          <Field label="How far do you want to run?" optional>
            <Toggle
              options={[
                { value: "off", label: "No preference" },
                { value: "on", label: "Set a range" },
              ]}
              value={draft.distanceOn ? "on" : "off"}
              onChange={(v) => set("distanceOn", v === "on")}
            />
            {draft.distanceOn && (
              <div className="mt-3">
                <RangeSlider
                  min={DISTANCE_MIN_KM}
                  max={DISTANCE_MAX_KM}
                  low={draft.preferredDistance}
                  high={draft.maxDistance}
                  onChange={(low, high) => {
                    set("preferredDistance", low);
                    set("maxDistance", high);
                  }}
                  format={(v) => formatDistance(v, unit)}
                  leftLabel="I'd love this far"
                  rightLabel="Up to this far"
                />
              </div>
            )}
          </Field>

          {/* Pace */}
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
                <RangeSlider
                  min={PACE_MIN_SEC_PER_KM}
                  max={PACE_MAX_SEC_PER_KM}
                  step={5}
                  low={draft.maxPace}
                  high={draft.preferredPace}
                  onChange={(low, high) => {
                    set("maxPace", low);
                    set("preferredPace", high);
                  }}
                  format={(v) => formatPace(v, unit)}
                  leftLabel="Faster"
                  rightLabel="Slower"
                />
              </div>
            )}
          </Field>

          {/* Finish */}
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
                  initialValue={draft.finishAddress ?? ""}
                  placeholder="Where are you finishing?"
                  onSelect={(r) => {
                    set("finishLocation", { lat: r.lat, lng: r.lng });
                    set("finishAddress", r.shortName);
                  }}
                />
              </div>
            )}
          </Field>

          {/* Latest finish */}
          <Field label="Latest you need to be done by" optional>
            <TimeField
              value={draft.latestFinishTime}
              onChange={(v) => set("latestFinishTime", v)}
            />
          </Field>

          {/* Rest stop */}
          <Field label="Do you want to stop along the way?">
            <Toggle
              options={[
                { value: "no", label: "No" },
                { value: "yes", label: "Yes" },
              ]}
              value={draft.restOn ? "yes" : "no"}
              onChange={(v) => set("restOn", v === "yes")}
            />
            {draft.restOn && (
              <div className="mt-3 space-y-3">
                <div>
                  <span className="text-xs text-text-dim">How long?</span>
                  <Slider
                    min={15}
                    max={90}
                    step={5}
                    value={draft.restDuration}
                    onChange={(v) => set("restDuration", v)}
                    format={(v) => `${v} min`}
                  />
                </div>
                <Toggle
                  options={[
                    { value: "anywhere", label: "Anywhere that works" },
                    { value: "specific", label: "Somewhere specific" },
                  ]}
                  value={draft.restLocationMode}
                  onChange={(v) => set("restLocationMode", v as "anywhere" | "specific")}
                />
                {draft.restLocationMode === "specific" && (
                  <AddressSearch
                    initialValue={draft.restLocationAddress ?? ""}
                    placeholder="Where would you like to stop?"
                    onSelect={(r) => {
                      set("restLocation", { lat: r.lat, lng: r.lng });
                      set("restLocationAddress", r.shortName);
                    }}
                  />
                )}
              </div>
            )}
          </Field>
        </div>
      )}

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
