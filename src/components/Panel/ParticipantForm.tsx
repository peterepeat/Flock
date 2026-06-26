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
  updateParticipant,
} from "@/lib/flockApi";
import { pinLabel, reverseGeocode } from "@/lib/geocodeClient";
import { getRecentRunners, isSameRunner, matchRunners, recentRunnerToConstraints, upsertRecentRunner } from "@/lib/recentStore";
import type { LatLng, LocationPin, Participant, ParticipantConstraints } from "@/lib/types";
import { recordParticipantEdit } from "@/lib/undoableEdits";
import {
  DISTANCE_MAX_KM,
  DISTANCE_MIN_KM,
  formatDistance,
  formatPace,
  PACE_MAX_SEC_PER_KM,
  PACE_MIN_SEC_PER_KM,
  secToTime,
  timeToSec,
} from "@/lib/units";
import { useFlockStore, useUnit } from "@/store/flockStore";

const TIME_MIN = 4 * 60; // 04:00
const TIME_MAX = 22 * 60; // 22:00
const TIME_STEP = 15;
// Pace is stored as sec/km (lower = faster), but the slider reads slowest→fastest
// (left→right), so we mirror the value about this sum to flip the track direction.
const PACE_SUM = PACE_MIN_SEC_PER_KM + PACE_MAX_SEC_PER_KM;
const toMin = (t: string | null, fallback: number) => (t ? Math.round(timeToSec(t) / 60) : fallback);

// A start/finish preference: no preference (the engine places it), at a configured
// waypoint, or a specific place (a map pin / address).
type PinMode = "auto" | "waypoint" | "manual";
interface PinDraft {
  mode: PinMode;
  waypointId: string; // when mode === "waypoint"
  location: LatLng | null; // when mode === "manual"
  address: string;
}
const emptyPin = (): PinDraft => ({ mode: "auto", waypointId: "", location: null, address: "" });

interface Draft {
  name: string;
  start: PinDraft;
  finish: PinDraft;
  distanceOn: boolean; // "how far can you run" — a hard cap
  distanceKm: number;
  paceOn: boolean; // "how fast can you run"
  paceSec: number;
  timeOn: boolean;
  earliestMin: number;
  latestMin: number;
}

function emptyDraft(): Draft {
  return {
    name: "",
    start: emptyPin(),
    finish: emptyPin(),
    distanceOn: false,
    distanceKm: 8,
    paceOn: false,
    paceSec: 360, // 6:00 /km
    timeOn: false,
    earliestMin: 7 * 60,
    latestMin: 10 * 60,
  };
}

function pinToDraft(pin: LocationPin): PinDraft {
  if (pin.kind === "waypoint") return { mode: "waypoint", waypointId: pin.waypointId, location: null, address: "" };
  if (pin.kind === "manual") return { mode: "manual", waypointId: "", location: pin.location, address: pin.address };
  return emptyPin();
}
function draftToPin(d: PinDraft): LocationPin {
  if (d.mode === "waypoint" && d.waypointId) return { kind: "waypoint", waypointId: d.waypointId };
  if (d.mode === "manual" && d.location) return { kind: "manual", location: d.location, address: d.address || "Dropped pin" };
  return { kind: "auto" };
}

function toConstraints(p: Participant): ParticipantConstraints {
  return {
    name: p.name,
    startPin: p.startPin,
    finishPin: p.finishPin,
    maxDistanceKm: p.maxDistanceKm,
    pace: p.pace,
    earliestStartTime: p.earliestStartTime,
    latestFinishTime: p.latestFinishTime,
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

  const unit = useUnit();
  const waypoints = useMemo(() => session?.waypoints ?? [], [session]);

  const existing = useMemo(
    () => session?.participants.find((p) => p.id === editingId) ?? null,
    [session, editingId],
  );

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [targetId, setTargetId] = useState<string | null>(editingId);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Quick-add from people YOU saved before (name typeahead, ADD mode only).
  const [nameOpen, setNameOpen] = useState(false);
  const [recentRunners, setRecentRunners] = useState<ParticipantConstraints[]>([]);
  const initialised = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const priorConstraintsRef = useRef<ParticipantConstraints | null>(null);
  const lastSavedConstraintsRef = useRef<ParticipantConstraints | null>(null);

  // Seed the draft from an existing participant (edit mode) once.
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    if (existing) {
      setTargetId(existing.id);
      priorConstraintsRef.current = toConstraints(existing);
      setDraft({
        name: existing.name,
        start: pinToDraft(existing.startPin),
        finish: pinToDraft(existing.finishPin),
        distanceOn: existing.maxDistanceKm != null,
        distanceKm: existing.maxDistanceKm ?? 8,
        paceOn: existing.pace != null,
        paceSec: existing.pace ?? 360,
        timeOn: existing.earliestStartTime != null || existing.latestFinishTime != null,
        earliestMin: toMin(existing.earliestStartTime, 7 * 60),
        latestMin: toMin(existing.latestFinishTime, 10 * 60),
      });
    }
  }, [existing]);

  // Load YOUR saved runners once when the ADD form opens, so the name typeahead is ready to suggest.
  useEffect(() => {
    if (!editingId) setRecentRunners(getRecentRunners());
  }, [editingId]);

  // Publish a manual start/finish pin to the map so it shows live.
  useEffect(() => {
    setPendingStart(draft.start.mode === "manual" ? draft.start.location : null);
  }, [draft.start.mode, draft.start.location, setPendingStart]);
  useEffect(() => {
    setPendingFinish(draft.finish.mode === "manual" ? draft.finish.location : null);
  }, [draft.finish.mode, draft.finish.location, setPendingFinish]);

  // Fold a map-dropped start pin into the draft + reverse-name it.
  useEffect(() => {
    if (!draftStart) return;
    const ll = draftStart;
    setDraft((d) => ({ ...d, start: { ...d.start, mode: "manual", location: ll, address: d.start.address || "Dropped pin" } }));
    setPlacingPin(false);
    setDraftStart(null);
    reverseGeocode(ll.lat, ll.lng).then((r) => {
      const label = pinLabel(r);
      if (!label) return;
      setDraft((d) => (d.start.location?.lat === ll.lat && d.start.location?.lng === ll.lng && (!d.start.address || d.start.address === "Dropped pin") ? { ...d, start: { ...d.start, address: label } } : d));
    });
  }, [draftStart, setPlacingPin, setDraftStart]);

  useEffect(() => {
    if (!draftFinish) return;
    const ll = draftFinish;
    setDraft((d) => ({ ...d, finish: { ...d.finish, mode: "manual", location: ll, address: d.finish.address || "Dropped pin" } }));
    setPlacingFinish(false);
    setDraftFinish(null);
    reverseGeocode(ll.lat, ll.lng).then((r) => {
      const label = pinLabel(r);
      if (!label) return;
      setDraft((d) => (d.finish.location?.lat === ll.lat && d.finish.location?.lng === ll.lng && (!d.finish.address || d.finish.address === "Dropped pin") ? { ...d, finish: { ...d.finish, address: label } } : d));
    });
  }, [draftFinish, setPlacingFinish, setDraftFinish]);

  function buildConstraints(d: Draft): ParticipantConstraints | null {
    if (!d.name.trim()) return null;
    return {
      name: d.name.trim(),
      startPin: draftToPin(d.start),
      finishPin: draftToPin(d.finish),
      maxDistanceKm: d.distanceOn ? d.distanceKm : null,
      pace: d.paceOn ? d.paceSec : null,
      earliestStartTime: d.timeOn ? secToTime(d.earliestMin * 60) : null,
      latestFinishTime: d.timeOn ? secToTime(d.latestMin * 60) : null,
    };
  }

  const constraints = buildConstraints(draft);
  const canSave = constraints != null;

  useEffect(() => {
    return () => {
      const prior = priorConstraintsRef.current;
      const next = lastSavedConstraintsRef.current;
      if (editingId && prior && next && JSON.stringify(prior) !== JSON.stringify(next)) {
        recordParticipantEdit(flockId, editingId, prior, next);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save (edit mode): debounce 500ms.
  useEffect(() => {
    if (!targetId || !constraints) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await updateParticipant(flockId, targetId, constraints);
        applyServerSession(updated, true);
        lastSavedConstraintsRef.current = constraints;
        upsertRecentRunner(constraints); // remember this runner (you saved them) for other flocks
        setSaveState("saved");
      } catch (err) {
        setSaveState("error");
        setErrorMsg(err instanceof FlockApiError ? err.message : "Could not save");
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
      upsertRecentRunner(constraints); // remember this runner (you saved them) for other flocks
      setSaveState("saved");
      closeForm();
    } catch (err) {
      setSaveState("error");
      setErrorMsg(err instanceof FlockApiError ? err.message : "Could not save your details");
    }
  }

  async function handleRemove() {
    if (!targetId) return;
    try {
      const updated = await removeParticipant(flockId, targetId);
      applyServerSession(updated, true);
      closeForm();
    } catch (err) {
      setErrorMsg(err instanceof FlockApiError ? err.message : "Could not remove");
    }
  }

  const setStart = (patch: Partial<PinDraft>) => setDraft((d) => ({ ...d, start: { ...d.start, ...patch } }));
  const setFinish = (patch: Partial<PinDraft>) => setDraft((d) => ({ ...d, finish: { ...d.finish, ...patch } }));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  // Picking a saved runner fills the whole draft from their stored prefs (a waypoint pin can't carry
  // across flocks, so recentRunnerToConstraints degrades it to "no preference").
  function applyRecentRunner(c: ParticipantConstraints) {
    const p = recentRunnerToConstraints(c);
    setDraft({
      name: p.name,
      start: pinToDraft(p.startPin),
      finish: pinToDraft(p.finishPin),
      distanceOn: p.maxDistanceKm != null,
      distanceKm: p.maxDistanceKm ?? 8,
      paceOn: p.pace != null,
      paceSec: p.pace ?? 360,
      timeOn: p.earliestStartTime != null || p.latestFinishTime != null,
      earliestMin: toMin(p.earliestStartTime, 7 * 60),
      latestMin: toMin(p.latestFinishTime, 10 * 60),
    });
    setNameOpen(false);
  }
  // Suggest saved runners only when ADDING (in edit mode the name is fixed to that person), and hide
  // anyone already in THIS flock as a perfect duplicate (same name AND prefs) — re-adding would just clone.
  const runnerSuggestions = editingId
    ? []
    : matchRunners(recentRunners, draft.name).filter(
        (c) => !(session?.participants ?? []).some((p) => isSameRunner(toConstraints(p), c)),
      );

  const toggleStartPin = () => { setPlacingFinish(false); setPlacingPin(!placingPin); };
  const toggleFinishPin = () => { setPlacingPin(false); setPlacingFinish(!placingFinish); };

  // Finish may only pin to a waypoint AT OR AFTER the start waypoint (keep the order
  // invariant), shown last-first per the design.
  const startWpIndex = draft.start.mode === "waypoint" ? waypoints.findIndex((w) => w.id === draft.start.waypointId) : -1;
  const finishWaypoints = waypoints.map((w, i) => ({ w, i })).filter(({ i }) => i > startWpIndex).reverse();

  return (
    <div className="space-y-6">
      {/* Name — with a typeahead of people you've saved before (add mode). */}
      <Field label="What should we call you?">
        <div className="relative">
          <input
            type="text"
            value={draft.name}
            placeholder="What should we call you?"
            onChange={(e) => { set("name", e.target.value); if (!editingId) setNameOpen(true); }}
            onFocus={() => { if (editingId) return; const r = getRecentRunners(); setRecentRunners(r); if (r.length > 0) setNameOpen(true); }}
            onBlur={() => setTimeout(() => setNameOpen(false), 120)}
            className="w-full rounded-lg border border-white/10 bg-surface-lift px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-accent/60"
          />
          {nameOpen && runnerSuggestions.length > 0 && (
            <ul className="absolute z-[1100] mt-1 max-h-56 w-full overflow-auto rounded-lg border border-white/10 bg-surface-mid shadow-panel flock-scroll">
              {runnerSuggestions.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyRecentRunner(c)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-text hover:bg-surface-lift"
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-fog/70" aria-hidden>Recent</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Field>

      {/* Start pin */}
      <Field label="Where will you start?" optional>
        <PinPicker
          mode={draft.start.mode}
          // Switching INTO "at a waypoint" defaults the id to the first option (what the select shows)
          // — otherwise, with one waypoint there's nothing to change, onChange never fires, and the pin
          // saves as "auto" (draftToPin needs a truthy waypointId).
          onMode={(m) => setStart(m === "waypoint" ? { mode: m, waypointId: draft.start.waypointId || waypoints[0]?.id || "" } : { mode: m })}
          waypoints={waypoints.map((w, i) => ({ id: w.id, label: `${i + 1}. ${w.name}` }))}
          waypointId={draft.start.waypointId}
          onWaypoint={(id) => setStart({ waypointId: id })}
          location={draft.start.location}
          address={draft.start.address}
          onSearch={(r) => setStart({ location: { lat: r.lat, lng: r.lng }, address: r.shortName })}
          placing={placingPin}
          onTogglePin={toggleStartPin}
        />
      </Field>

      {/* Finish pin */}
      <Field label="Where will you finish?" optional>
        <PinPicker
          mode={draft.finish.mode}
          onMode={(m) => setFinish(m === "waypoint" ? { mode: m, waypointId: draft.finish.waypointId || finishWaypoints[0]?.w.id || "" } : { mode: m })}
          waypoints={finishWaypoints.map(({ w, i }) => ({ id: w.id, label: `${i + 1}. ${w.name}` }))}
          waypointId={draft.finish.waypointId}
          onWaypoint={(id) => setFinish({ waypointId: id })}
          location={draft.finish.location}
          address={draft.finish.address}
          onSearch={(r) => setFinish({ location: { lat: r.lat, lng: r.lng }, address: r.shortName })}
          placing={placingFinish}
          onTogglePin={toggleFinishPin}
        />
      </Field>

      {/* How far can you run? — a hard cap */}
      <Field label="How far can you run?" optional>
        <Toggle
          options={[{ value: "off", label: "No limit" }, { value: "on", label: "Set a limit" }]}
          value={draft.distanceOn ? "on" : "off"}
          onChange={(v) => set("distanceOn", v === "on")}
        />
        {draft.distanceOn && (
          <div className="mt-3">
            <Slider min={DISTANCE_MIN_KM} max={DISTANCE_MAX_KM} value={draft.distanceKm} onChange={(v) => set("distanceKm", v)} format={(v) => formatDistance(v, unit)} />
          </div>
        )}
      </Field>

      {/* How fast can you run? */}
      <Field label="How fast can you run?" optional>
        <Toggle
          options={[{ value: "off", label: "No limit" }, { value: "on", label: "Set a pace" }]}
          value={draft.paceOn ? "on" : "off"}
          onChange={(v) => set("paceOn", v === "on")}
        />
        {draft.paceOn && (
          <div className="mt-3">
            {/* Track reads slowest (left) → fastest (right): mirror the stored sec/km value. */}
            <Slider min={PACE_MIN_SEC_PER_KM} max={PACE_MAX_SEC_PER_KM} step={5} value={PACE_SUM - draft.paceSec} onChange={(v) => set("paceSec", PACE_SUM - v)} format={(v) => formatPace(PACE_SUM - v, unit)} />
            <div className="mt-1 flex justify-between text-[11px] text-fog">
              <span>Slower</span>
              <span>Faster</span>
            </div>
          </div>
        )}
      </Field>

      {/* Time constraints */}
      <Field label="What are your time constraints?" optional>
        <Toggle
          options={[{ value: "off", label: "None" }, { value: "on", label: "Set a range" }]}
          value={draft.timeOn ? "on" : "off"}
          onChange={(v) => set("timeOn", v === "on")}
        />
        {draft.timeOn && (
          <div className="mt-3">
            <RangeSlider
              min={TIME_MIN} max={TIME_MAX} step={TIME_STEP} low={draft.earliestMin} high={draft.latestMin}
              onChange={(low, high) => { set("earliestMin", low); set("latestMin", high); }}
              format={(m) => secToTime(m * 60)}
              leftThumb="square" rightThumb="square" leftLabel="Can't leave before" rightLabel="Must be done by"
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
              <button type="button" onClick={handleRemove} className="text-xs text-fog hover:text-accent">Leave the flock</button>
              <button type="button" onClick={closeForm} className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110">Done</button>
            </div>
          </>
        ) : (
          <>
            <button type="button" onClick={closeForm} className="text-sm text-fog hover:text-text">Cancel</button>
            <button type="button" disabled={!canSave || saveState === "saving"} onClick={handleCreate} className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
              {saveState === "saving" ? "Saving…" : "Join the flock"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// --- the start/finish pin selector --------------------------------------------
function PinPicker(props: {
  mode: PinMode;
  onMode: (m: PinMode) => void;
  waypoints: { id: string; label: string }[];
  waypointId: string;
  onWaypoint: (id: string) => void;
  location: LatLng | null;
  address: string;
  onSearch: (r: { lat: number; lng: number; shortName: string }) => void;
  placing: boolean;
  onTogglePin: () => void;
}) {
  const { mode, onMode, waypoints, waypointId, onWaypoint, location, address, onSearch, placing, onTogglePin } = props;
  const opts: { value: PinMode; label: string }[] = [
    { value: "auto", label: "No preference" },
    ...(waypoints.length ? [{ value: "waypoint" as const, label: "At a waypoint" }] : []),
    { value: "manual", label: "A specific place" },
  ];
  return (
    <div>
      <Toggle options={opts} value={mode} onChange={(v) => onMode(v as PinMode)} />
      {mode === "waypoint" && waypoints.length > 0 && (
        <select
          value={waypointId || waypoints[0]?.id}
          onChange={(e) => onWaypoint(e.target.value)}
          className="mt-3 w-full rounded-lg border border-white/10 bg-surface-lift px-3 py-2.5 text-sm text-text outline-none focus:border-accent/60"
        >
          {waypoints.map((w) => (
            <option key={w.id} value={w.id}>{w.label}</option>
          ))}
        </select>
      )}
      {mode === "manual" && (
        <div className="mt-3">
          <AddressSearch
            initialValue={address === "Dropped pin" ? "" : address}
            placeholder="Search for a place"
            onSelect={(r) => onSearch(r)}
          />
          <div className="mt-2 flex items-center gap-3">
            <button type="button" onClick={onTogglePin} className={`text-xs ${placing ? "text-accent" : "text-fog hover:text-text"}`}>
              {placing ? "Tap the map to drop your pin…" : "…or tap the map to drop a pin"}
            </button>
            {location && (
              <span className="mono text-xs text-together">✓ {location.lat.toFixed(4)}, {location.lng.toFixed(4)}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
