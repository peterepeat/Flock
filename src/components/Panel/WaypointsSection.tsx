"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import AddressSearch from "@/components/ui/AddressSearch";
import Slider from "@/components/ui/Slider";
import Toggle from "@/components/ui/Toggle";
import { FlockApiError, renameWaypoints } from "@/lib/flockApi";
import { buildFlockGpx, parseFlockGpx, waypointNameIsAuto } from "@/lib/flockGpx";
import { pinLabel, reverseGeocode } from "@/lib/geocodeClient";
import { createLogger } from "@/lib/logger";
import type { FlockWaypoint, LatLng } from "@/lib/types";
import {
  uAddWaypoint,
  uImportRoute,
  uRemoveWaypoint,
  uReorderWaypoints,
  uUpdateWaypoint,
} from "@/lib/undoableEdits";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("waypoints");

// Cap how many auto-named points we reverse-geocode (a huge route shouldn't run
// the geocoder forever); the rest keep their placeholder names.
const REVERSE_NAME_CAP = 60;
// Flush accumulated names to the server every this many resolved — batched so a
// big import is a few cosmetic writes, not dozens.
const NAME_FLUSH_EVERY = 8;
// Bumped per import so a superseded background run (a second import) bails.
let importGeneration = 0;

/**
 * After a GPX import, reverse-name the auto-named waypoints ("Start", "Point 3",
 * …) in the BACKGROUND, in SERIES (one at a time — a gentle trickle the free
 * geocoder tolerates, vs a burst it throttles). Names are flushed in small batches
 * via renameWaypoints, which does NOT recompute the route AND only fills names
 * still on placeholders (the server guard), so it never clobbers a user edit.
 * Best-effort: any point the geocoder can't name keeps its placeholder.
 */
async function nameImportedInBackground(
  flockId: string,
  gen: number,
  waypoints: FlockWaypoint[],
  onProgress: (msg: string | null) => void,
): Promise<void> {
  const targets = waypoints.filter((w) => waypointNameIsAuto(w)).slice(0, REVERSE_NAME_CAP);
  if (targets.length === 0) return;

  const store = useFlockStore;
  const superseded = () => store.getState().flockId !== flockId || importGeneration !== gen;
  let pending: Record<string, { name: string; address: string }> = {};
  let named = 0;

  const flush = async () => {
    if (Object.keys(pending).length === 0) return;
    // Hold off ONLY while a route recalc is pending/in flight — a rename bumps
    // updatedAt, and during the computed-null window of an active calc that would
    // re-trigger / invalidate it. A recalc is pending when the route is null AND
    // there's someone to route for; with no participants yet (e.g. importing into
    // an empty flock) there's no calc, so naming proceeds immediately.
    const s = store.getState().session;
    const recalcPending = s?.computedRoutes == null && (s?.participants.length ?? 0) > 0;
    if (recalcPending) return; // names keep accumulating until the route settles
    const batch = pending;
    pending = {};
    try {
      await renameWaypoints(flockId, batch); // server only fills ids still on placeholders
    } catch (err) {
      log.warn("background rename flush failed", { error: String(err) });
    }
  };

  for (let i = 0; i < targets.length; i++) {
    if (superseded()) return; // flock switched / newer import — drop unsent names
    try {
      const r = await reverseGeocode(targets[i].location.lat, targets[i].location.lng);
      if (superseded()) return;
      const label = pinLabel(r);
      if (label) {
        pending[targets[i].id] = { name: label, address: label };
        named++;
      }
    } catch (err) {
      log.warn("background geocode failed", { error: String(err) }); // skip this one, keep going
    }
    onProgress(`Naming waypoints in the background… ${i + 1}/${targets.length}`);
    if (Object.keys(pending).length >= NAME_FLUSH_EVERY) await flush();
  }
  await flush();
  log.info("background naming complete", { targets: targets.length, named });
  if (!superseded()) onProgress(named > 0 ? `Named ${named} of ${targets.length} imported waypoints.` : null);
}

interface EditorData {
  name: string;
  address: string;
  location: LatLng;
  stopMinutes: number;
}

export default function WaypointsSection() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const waypointPin = useFlockStore((s) => s.waypointPin);
  // The add/edit editor lives in the store so the map can open a waypoint for
  // editing and coordinate the "tap empty map to add" gesture.
  const editor = useFlockStore((s) => s.waypointEditor);
  const openAddWaypoint = useFlockStore((s) => s.openAddWaypoint);
  const openEditWaypoint = useFlockStore((s) => s.openEditWaypoint);
  const close = useFlockStore((s) => s.closeWaypointEditor);
  const setHoveredWaypoint = useFlockStore((s) => s.setHoveredWaypoint);

  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [ioMsg, setIoMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  // The active editor (edit row or add form), so we can scroll it into view when
  // it opens — e.g. after tapping a waypoint on the map, which would otherwise
  // leave the editor below the fold in a tall sheet.
  const editorAnchorRef = useRef<HTMLDivElement | HTMLLIElement | null>(null);
  const editorKey = editor.mode === "edit" ? `edit:${editor.id}` : editor.mode;

  const locked = session?.lockedAt != null;
  const waypoints = session?.waypoints ?? [];
  const waypointEtas = session?.waypointEtas ?? {};

  // A pin dropped on the map with no editor open starts a fresh add (the open
  // editor, if any, folds the pin in itself — see WaypointEditor).
  useEffect(() => {
    if (waypointPin && useFlockStore.getState().waypointEditor.mode === "closed") openAddWaypoint();
  }, [waypointPin, openAddWaypoint]);

  // Clear any lingering map emphasis when this section unmounts (collapsed, or the
  // join form took over) so a marker isn't left highlighted with no row to match.
  useEffect(() => () => setHoveredWaypoint(null), [setHoveredWaypoint]);

  // When an editor opens, bring it into view (after the sheet's height transition
  // settles) so the user sees what they're editing rather than a wall of drawer.
  useEffect(() => {
    if (editor.mode === "closed") return;
    const t = setTimeout(() => {
      editorAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 320);
    return () => clearTimeout(t);
  }, [editorKey, editor.mode]);

  // Reconcile the editor against the live session: if the row being edited
  // disappears (a concurrent remove via polling) or the flock gets locked
  // mid-edit/add, collapse the editor — otherwise the panel wedges with no
  // editor AND no "+ Add" button (both gated on the editor state).
  useEffect(() => {
    const ed = useFlockStore.getState().waypointEditor;
    const wps = session?.waypoints ?? [];
    const isLocked = session?.lockedAt != null;
    if (ed.mode === "edit" && (isLocked || !wps.some((w) => w.id === ed.id))) close();
    else if (ed.mode === "add" && isLocked) close();
  }, [session, close]);

  async function handleAdd(data: EditorData) {
    await uAddWaypoint(flockId, { ...data });
    close();
    log.info("waypoint added", { stop: data.stopMinutes });
  }

  async function handleSave(id: string, data: EditorData) {
    await uUpdateWaypoint(flockId, id, { ...data });
    close();
    log.info("waypoint edited", { id: id.slice(0, 4) });
  }

  async function handleRemove(id: string) {
    try {
      await uRemoveWaypoint(flockId, id);
      if (editor.mode === "edit" && editor.id === id) close();
    } catch (err) {
      log.error("remove failed", { error: String(err) });
    }
  }

  function handleExport() {
    if (!session) return;
    const result = buildFlockGpx(session);
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.xml], { type: "application/gpx+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log.info("route exported", { waypoints: waypoints.length });
  }

  async function handleImport(file: File) {
    setIoMsg(null);
    try {
      const parsed = parseFlockGpx(await file.text());
      if (parsed.waypoints.length === 0) {
        setIoMsg(parsed.warnings[0] ?? "No route points found in that GPX.");
        return;
      }
      // Import immediately with whatever names the GPX provided (placeholders for
      // unnamed points) — the route shows right away, no waiting on the geocoder.
      const session = await uImportRoute(flockId, parsed.waypoints, parsed.gpxPassthrough);
      setIoMsg(
        parsed.warnings.length
          ? parsed.warnings.join(" ")
          : `Imported ${session.waypoints.length} waypoints.`,
      );
      log.info("route imported", { waypoints: session.waypoints.length });
      // Then fill in real place names for the unnamed points in the background,
      // in series (gentle on the free geocoder), updating the list as they resolve.
      const gen = ++importGeneration;
      void nameImportedInBackground(flockId, gen, session.waypoints, setIoMsg).catch((err) =>
        log.warn("background naming failed", { error: String(err) }),
      );
    } catch (err) {
      setIoMsg(
        err instanceof FlockApiError || err instanceof Error
          ? err.message
          : "Could not import that GPX.",
      );
      log.error("import failed", { error: String(err) });
    }
  }

  // Move the dragged waypoint to gap index `to` (0..length); persist the order.
  async function handleReorder(to: number) {
    if (dragId == null) return;
    const orig = waypoints.map((w) => w.id);
    const from = orig.indexOf(dragId);
    if (from === -1) return;
    const ids = [...orig];
    ids.splice(from, 1);
    // Removing an earlier item shifts every later gap left by one.
    ids.splice(from < to ? to - 1 : to, 0, dragId);
    if (ids.every((id, k) => id === orig[k])) return; // no change
    try {
      await uReorderWaypoints(flockId, ids);
      log.info("waypoints reordered", { order: ids.map((s) => s.slice(0, 4)) });
    } catch (err) {
      log.error("reorder failed", { error: String(err) });
    }
  }

  if (locked && waypoints.length === 0) return null;

  const canReorder = !locked && waypoints.length > 1 && editor.mode === "closed";
  const dropLine = (gap: number) =>
    dragId != null && overIndex === gap ? (
      <li aria-hidden className="h-[2px] rounded-full bg-accent" />
    ) : null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-dim">
        Add a shared waypoint — a café, a landmark, a meeting spot. The group’s route
        runs through it, so you spend more time flocking together.
      </p>

      {waypoints.length > 0 && (
        <ul className="space-y-1.5">
          {waypoints.map((w, i) => {
            const editing = editor.mode === "edit" && editor.id === w.id && !locked;
            const eta = waypointEtas[w.id];
            return (
              <Fragment key={w.id}>
                {dropLine(i)}
                {editing ? (
                  <li ref={(el) => { editorAnchorRef.current = el; }}>
                    <WaypointEditor
                      initial={{
                        name: w.name,
                        address: w.address,
                        location: w.location,
                        stopMinutes: w.stopMinutes,
                      }}
                      submitLabel="Save"
                      onSubmit={(d) => handleSave(w.id, d)}
                      onCancel={close}
                    />
                  </li>
                ) : (
                  <li
                    draggable={canReorder}
                    onMouseEnter={() => setHoveredWaypoint(w.id)}
                    onMouseLeave={() => setHoveredWaypoint(null)}
                    onDragStart={() => {
                      draggingRef.current = true;
                      setDragId(w.id);
                    }}
                    onDragOver={(e) => {
                      if (!canReorder || dragId == null) return;
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setOverIndex(e.clientY < r.top + r.height / 2 ? i : i + 1);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (overIndex != null) void handleReorder(overIndex);
                      setDragId(null);
                      setOverIndex(null);
                    }}
                    onDragEnd={() => {
                      draggingRef.current = false;
                      setDragId(null);
                      setOverIndex(null);
                    }}
                    className={`flex items-center gap-2 rounded-lg bg-surface-mid px-2.5 py-2 transition ${
                      dragId === w.id ? "opacity-40" : ""
                    }`}
                  >
                    {canReorder && (
                      <span
                        className="shrink-0 cursor-grab text-fog active:cursor-grabbing"
                        aria-hidden
                        title="Drag to reorder"
                      >
                        <GripIcon />
                      </span>
                    )}
                    <span className="mono flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-lift text-[11px] text-text">
                      {i + 1}
                    </span>
                    <div
                      role={locked ? undefined : "button"}
                      tabIndex={locked ? undefined : 0}
                      title={locked ? undefined : "Tap to edit"}
                      onClick={() => {
                        if (locked || draggingRef.current) return;
                        openEditWaypoint(w.id);
                      }}
                      onKeyDown={(e) => {
                        if (locked) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openEditWaypoint(w.id);
                        }
                      }}
                      className={`min-w-0 flex-1 text-left ${locked ? "" : "cursor-pointer"}`}
                    >
                      <span className="block truncate text-sm text-text">{w.name}</span>
                      {(eta || w.stopMinutes > 0) && (
                        <span className="mono block text-xs">
                          {eta && <span className="text-fog">passes ~{eta}</span>}
                          {eta && w.stopMinutes > 0 && <span className="text-fog"> · </span>}
                          {w.stopMinutes > 0 && (
                            <span className="text-together">☕ {w.stopMinutes} min stop</span>
                          )}
                        </span>
                      )}
                    </div>
                    {!locked && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRemove(w.id);
                        }}
                        className="shrink-0 text-fog hover:text-accent"
                        aria-label="Remove waypoint"
                      >
                        ×
                      </button>
                    )}
                  </li>
                )}
              </Fragment>
            );
          })}
          {dropLine(waypoints.length)}
        </ul>
      )}

      {!locked && editor.mode === "closed" && (
        <button
          type="button"
          onClick={() => openAddWaypoint()}
          className="w-full rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
        >
          + Add a waypoint
        </button>
      )}

      {!locked && editor.mode === "add" && (
        <div ref={(el) => { editorAnchorRef.current = el; }}>
          <WaypointEditor submitLabel="Add waypoint" onSubmit={handleAdd} onCancel={close} />
        </div>
      )}

      {(waypoints.length > 0 || !locked) && (
        <div className="space-y-2 border-t border-white/5 pt-3">
          <div className="flex items-center gap-4 text-xs">
            {!locked && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="text-fog hover:text-text"
              >
                Import GPX
              </button>
            )}
            {waypoints.length > 0 && (
              <button type="button" onClick={handleExport} className="text-fog hover:text-text">
                Export GPX
              </button>
            )}
          </div>
          {ioMsg && <p className="text-xs text-text-dim">{ioMsg}</p>}
          <input
            ref={fileRef}
            type="file"
            accept=".gpx,application/gpx+xml,application/xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
              e.target.value = ""; // allow re-importing the same file
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The add/edit form for a single waypoint. Used both for adding (no `initial`)
 * and for inline editing a row (`initial` pre-fills it). Only one is ever mounted
 * at a time, so it owns the map-place mode and folds a dropped pin into itself.
 */
function WaypointEditor({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: { name: string; address: string; location: LatLng | null; stopMinutes: number };
  submitLabel: string;
  onSubmit: (data: EditorData) => Promise<void>;
  onCancel: () => void;
}) {
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);
  const setPlacingWaypoint = useFlockStore((s) => s.setPlacingWaypoint);
  const waypointPin = useFlockStore((s) => s.waypointPin);
  const setWaypointPin = useFlockStore((s) => s.setWaypointPin);

  const [name, setName] = useState(initial?.name ?? "");
  const [location, setLocation] = useState<LatLng | null>(initial?.location ?? null);
  const [address, setAddress] = useState(initial?.address ?? "");
  const [stopOn, setStopOn] = useState((initial?.stopMinutes ?? 0) > 0);
  const [stopMinutes, setStopMinutes] = useState(
    initial && initial.stopMinutes > 0 ? initial.stopMinutes : 30,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fold a map-dropped pin into this editor (only one editor is open at a time),
  // then reverse-geocode it to suggest a name (nearby POI / address) — non-blocking,
  // and only applied if the user hasn't typed over it or dropped a newer pin.
  const lastPinRef = useRef<LatLng | null>(null);
  useEffect(() => {
    if (!waypointPin) return;
    const ll = waypointPin;
    lastPinRef.current = ll;
    setLocation(ll);
    setAddress((a) => a || "Dropped pin");
    setPlacingWaypoint(false);
    setWaypointPin(null);
    reverseGeocode(ll.lat, ll.lng).then((r) => {
      if (lastPinRef.current !== ll) return; // a newer pin superseded this one
      const label = pinLabel(r);
      if (!label) return;
      setAddress((a) => (!a || a === "Dropped pin" ? label : a));
      if (r?.name) setName((n) => n || r.name!);
    });
  }, [waypointPin, setPlacingWaypoint, setWaypointPin]);

  // Leaving the editor by ANY path (cancel, save, switching rows, programmatic
  // close) must exit map-placing mode so the crosshair never lingers.
  useEffect(() => () => setPlacingWaypoint(false), [setPlacingWaypoint]);

  function cancel() {
    setPlacingWaypoint(false);
    onCancel();
  }

  async function submit() {
    if (!location) {
      setError("Pick a place first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim() || address || "Waypoint",
        address,
        location,
        stopMinutes: stopOn ? stopMinutes : 0,
      });
      setPlacingWaypoint(false);
    } catch (err) {
      setError(err instanceof FlockApiError ? err.message : "Could not save waypoint");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-white/5 pt-3">
      <AddressSearch
        initialValue={address === "Dropped pin" ? "" : address}
        placeholder="Search for a place"
        onSelect={(r) => {
          setLocation({ lat: r.lat, lng: r.lng });
          setAddress(r.shortName);
          if (!name) setName(r.shortName);
        }}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setPlacingWaypoint(!placingWaypoint)}
          className={`text-xs ${placingWaypoint ? "text-accent" : "text-fog hover:text-text"}`}
        >
          {placingWaypoint ? "Tap the map to drop it…" : "…or tap the map"}
        </button>
        {location && (
          <span className="mono text-xs text-together">
            ✓ {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
          </span>
        )}
      </div>

      <input
        type="text"
        value={name}
        placeholder="Name it (optional)"
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-surface-lift px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-accent/60"
      />

      <div>
        <Toggle
          options={[
            { value: "no", label: "Just pass through" },
            { value: "yes", label: "Stop here" },
          ]}
          value={stopOn ? "yes" : "no"}
          onChange={(v) => setStopOn(v === "yes")}
        />
        {stopOn && (
          <div className="mt-2">
            <span className="text-xs text-text-dim">How long?</span>
            <Slider
              min={5}
              max={90}
              step={5}
              value={stopMinutes}
              onChange={setStopMinutes}
              format={(v) => `${v} min`}
            />
          </div>
        )}
      </div>

      {error && <p className="text-xs text-accent">{error}</p>}

      <div className="flex items-center justify-between">
        <button type="button" onClick={cancel} className="text-sm text-fog hover:text-text">
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !location}
          className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

/** The little six-dot drag handle. */
function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="3" r="1.3" />
      <circle cx="8" cy="3" r="1.3" />
      <circle cx="2" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="2" cy="13" r="1.3" />
      <circle cx="8" cy="13" r="1.3" />
    </svg>
  );
}
