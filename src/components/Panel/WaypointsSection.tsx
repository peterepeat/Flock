"use client";

import { useEffect, useState } from "react";

import AddressSearch from "@/components/ui/AddressSearch";
import Slider from "@/components/ui/Slider";
import Toggle from "@/components/ui/Toggle";
import { addWaypoint, FlockApiError, removeWaypoint, reorderWaypoints } from "@/lib/flockApi";
import { buildFlockGpx } from "@/lib/flockGpx";
import { createLogger } from "@/lib/logger";
import type { LatLng } from "@/lib/types";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("waypoints");

export default function WaypointsSection() {
  const flockId = useFlockStore((s) => s.flockId)!;
  const session = useFlockStore((s) => s.session);
  const applyServerSession = useFlockStore((s) => s.applyServerSession);
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);
  const setPlacingWaypoint = useFlockStore((s) => s.setPlacingWaypoint);
  const waypointPin = useFlockStore((s) => s.waypointPin);
  const setWaypointPin = useFlockStore((s) => s.setWaypointPin);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState<LatLng | null>(null);
  const [address, setAddress] = useState("");
  const [stopOn, setStopOn] = useState(false);
  const [stopMinutes, setStopMinutes] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const locked = session?.lockedAt != null;
  const waypoints = session?.waypoints ?? [];
  const waypointEtas = session?.waypointEtas ?? {};

  // Fold a map-dropped pin into the add form.
  useEffect(() => {
    if (waypointPin) {
      setLocation(waypointPin);
      setAddress((a) => a || "Dropped pin");
      setPlacingWaypoint(false);
      setWaypointPin(null);
      setAdding(true);
    }
  }, [waypointPin, setPlacingWaypoint, setWaypointPin]);

  function resetForm() {
    setName("");
    setLocation(null);
    setAddress("");
    setStopOn(false);
    setStopMinutes(20);
    setError(null);
    setAdding(false);
    setPlacingWaypoint(false);
  }

  async function handleAdd() {
    if (!location) {
      setError("Pick a place first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await addWaypoint(flockId, {
        location,
        address,
        name: name.trim() || address || "Waypoint",
        stopMinutes: stopOn ? stopMinutes : 0,
      });
      applyServerSession(updated, true);
      log.info("waypoint added", { stop: stopOn ? stopMinutes : 0 });
      resetForm();
    } catch (err) {
      setError(err instanceof FlockApiError ? err.message : "Could not add waypoint");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    try {
      const updated = await removeWaypoint(flockId, id);
      applyServerSession(updated, true);
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

  // Drop the dragged waypoint into the target's slot; persist the new order.
  async function handleReorder(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = waypoints.map((w) => w.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    try {
      const updated = await reorderWaypoints(flockId, ids);
      applyServerSession(updated, true);
      log.info("waypoints reordered", { order: ids.map((s) => s.slice(0, 4)) });
    } catch (err) {
      log.error("reorder failed", { error: String(err) });
    }
  }

  if (locked && waypoints.length === 0) return null;

  return (
    <div className="space-y-3 rounded-xl bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text">Where you’ll run together</h3>
        {waypoints.length > 0 && (
          <span className="mono text-xs text-fog">{waypoints.length}</span>
        )}
      </div>
      <p className="text-xs text-text-dim">
        Add a shared waypoint — a café, a landmark, a meeting spot. Everyone’s route
        runs through it, so you spend more time flocking together.
      </p>

      {waypoints.length > 0 && (
        <ul className="space-y-1.5">
          {waypoints.map((w, i) => {
            const canReorder = !locked && waypoints.length > 1;
            const eta = waypointEtas[w.id];
            return (
              <li
                key={w.id}
                draggable={canReorder}
                onDragStart={() => setDragId(w.id)}
                onDragEnter={() => canReorder && setOverId(w.id)}
                onDragOver={(e) => {
                  if (canReorder) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleReorder(w.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                className={`flex items-center gap-2 rounded-lg bg-surface-mid px-2.5 py-2 transition ${
                  dragId === w.id ? "opacity-40" : ""
                } ${overId === w.id && dragId !== w.id ? "ring-1 ring-accent/70" : ""}`}
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
                <span className="min-w-0 flex-1">
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
                </span>
                {!locked && (
                  <button
                    type="button"
                    onClick={() => handleRemove(w.id)}
                    className="shrink-0 text-fog hover:text-accent"
                    aria-label="Remove waypoint"
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!locked && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-sm text-accent hover:brightness-110"
        >
          + Add a waypoint
        </button>
      )}

      {!locked && adding && (
        <div className="space-y-3 border-t border-white/5 pt-3">
          <AddressSearch
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
            <button type="button" onClick={resetForm} className="text-sm text-fog hover:text-text">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={busy || !location}
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add waypoint"}
            </button>
          </div>
        </div>
      )}

      {waypoints.length > 0 && (
        <div className="flex items-center gap-4 border-t border-white/5 pt-3 text-xs">
          <button type="button" onClick={handleExport} className="text-fog hover:text-text">
            Export GPX
          </button>
        </div>
      )}
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
