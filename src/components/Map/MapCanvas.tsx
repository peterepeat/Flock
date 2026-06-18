"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";

import { initial } from "@/lib/colors";
import { ownsParticipant } from "@/lib/editTokens";
import { updateParticipant, updateWaypoint } from "@/lib/flockApi";
import { bearingRad, distanceMeters, toLeaflet } from "@/lib/geo";
import { createLogger } from "@/lib/logger";
import type { LatLng } from "@/lib/types";
import { formatDistance } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("map");

// Default view: Melbourne (matches the spec's example geography).
const DEFAULT_CENTER: [number, number] = [-37.8136, 144.9631];
const DEFAULT_ZOOM = 13;

const round4 = (n: number) => Number(n.toFixed(4));

type MarkerKind = "start" | "finish" | "rest";

function divMarker(color: string, label: string, kind: MarkerKind, draggable = false): L.DivIcon {
  const size = kind === "start" ? 30 : kind === "finish" ? 26 : 28;
  const anchor = size / 2;
  const cursor = draggable ? ";cursor:grab" : "";
  return L.divIcon({
    className: "", // drop leaflet's default white box
    html: `<div class="flock-marker flock-marker--${kind}" style="background:${color}${cursor}">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
  });
}

/** A numbered pin for a shared waypoint (☕ if it has a stop). */
function waypointIcon(order: number, hasStop: boolean, draggable = false): L.DivIcon {
  const cursor = draggable ? "cursor:grab;" : "";
  return L.divIcon({
    className: "",
    html:
      `<div style="${cursor}display:flex;align-items:center;justify-content:center;` +
      `width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);` +
      `background:var(--text);border:2px solid var(--accent);` +
      `box-shadow:0 2px 8px rgba(0,0,0,0.5);">` +
      `<span style="transform:rotate(45deg);font-size:12px;font-weight:600;color:#15151a;">` +
      `${hasStop ? "☕" : order}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 24],
  });
}

// Direction-of-travel chevrons are sampled along the flock spine at this ground
// spacing (metres). Sparse enough to read as flow, not as a dotted line.
const SPINE_ARROW_SPACING_M = 700;

/** A chevron pointing along a route's direction of travel (deg clockwise from north).
    `light` = white chevron (for a coloured route line); default = dark (for the white spine). */
function arrowIcon(deg: number, light = false): L.DivIcon {
  const stroke = light ? "#ffffff" : "#0b1413";
  const shadow = light ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.9)";
  return L.divIcon({
    className: "",
    html:
      `<div style="transform:rotate(${deg}deg);width:16px;height:16px;` +
      `filter:drop-shadow(0 0 1px ${shadow});">` +
      `<svg viewBox="0 0 16 16" width="16" height="16">` +
      `<path d="M4 10 L8 5 L12 10" fill="none" stroke="${stroke}" stroke-width="2.4" ` +
      `stroke-linecap="round" stroke-linejoin="round"/></svg></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

/** Sample direction chevrons along a [lng,lat] polyline, one every `spacingM`
    metres (first at half-spacing), each oriented to the local heading. */
function arrowsAlong(coords: number[][], spacingM: number): { lat: number; lng: number; deg: number }[] {
  if (coords.length < 2) return [];
  const pts = coords.map(([lng, lat]) => ({ lat, lng }) as LatLng);
  const out: { lat: number; lng: number; deg: number }[] = [];
  let acc = 0;
  let next = spacingM / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = distanceMeters(a, b);
    if (segLen < 1e-6) continue;
    const deg = (bearingRad(a, b) * 180) / Math.PI;
    while (next <= acc + segLen) {
      const f = (next - acc) / segLen;
      out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, deg });
      next += spacingM;
    }
    acc += segLen;
  }
  return out;
}

/** A small glowing diamond marking where the flock converges. */
function meetIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html:
      `<div style="width:14px;height:14px;transform:rotate(45deg);` +
      `background:var(--together);border:2px solid #0b1413;` +
      `box-shadow:0 0 10px var(--together);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

/**
 * Reflect "placing" mode as a crosshair cursor. MapContainer's `style` prop is
 * create-only in react-leaflet (not re-applied on re-render), so we set the
 * cursor imperatively on the live container instead.
 */
function CursorMode() {
  const map = useMap();
  const placingPin = useFlockStore((s) => s.placingPin);
  const placingFinish = useFlockStore((s) => s.placingFinish);
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);
  useEffect(() => {
    map.getContainer().style.cursor =
      placingPin || placingFinish || placingWaypoint ? "crosshair" : "";
  }, [map, placingPin, placingFinish, placingWaypoint]);
  return null;
}

/** Click-to-place handler for the start pin, finish pin, or a shared waypoint. */
function ClickHandler() {
  const placingPin = useFlockStore((s) => s.placingPin);
  const placingFinish = useFlockStore((s) => s.placingFinish);
  const formOpen = useFlockStore((s) => s.formOpen);
  const setDraftStart = useFlockStore((s) => s.setDraftStart);
  const setDraftFinish = useFlockStore((s) => s.setDraftFinish);
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);
  const setWaypointPin = useFlockStore((s) => s.setWaypointPin);

  useMapEvents({
    click(e) {
      const ll: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (placingWaypoint) {
        log.debug("map click → waypoint", { lat: ll.lat, lng: ll.lng });
        setWaypointPin(ll);
        return;
      }
      if (formOpen && placingFinish) {
        log.debug("map click → finish pin", { lat: ll.lat, lng: ll.lng });
        setDraftFinish(ll);
        return;
      }
      if (formOpen && placingPin) {
        log.debug("map click → start pin", { lat: ll.lat, lng: ll.lng });
        setDraftStart(ll);
        return;
      }
      // A bare click on empty map (Leaflet doesn't fire this for marker/route
      // clicks) clears any route focus.
      useFlockStore.getState().setSelected(null);
    },
  });
  return null;
}

/** Fit the map to all known points whenever their set meaningfully changes. */
function FitBounds({ points }: { points: LatLng[] }) {
  const map = useMap();
  const sig = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join("|");
  const lastSig = useRef("");

  useEffect(() => {
    if (points.length === 0) return;
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    if (points.length === 1) {
      map.setView(toLeaflet(points[0]), 14, { animate: true });
    } else {
      const bounds = L.latLngBounds(points.map(toLeaflet));
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15, animate: true });
    }
    log.debug("fit bounds", { count: points.length });
  }, [sig, points, map]);

  return null;
}

export default function MapCanvas() {
  const session = useFlockStore((s) => s.session);
  const hovered = useFlockStore((s) => s.hoveredParticipantId);
  const selected = useFlockStore((s) => s.selectedParticipantId);
  // The focused runner: a persistent click-selection, else the transient hover.
  // When set, only this runner's route is drawn (the rest declutter to the shared
  // spine + glow); when null, no individual route lines show.
  const focus = selected ?? hovered;
  const pendingStart = useFlockStore((s) => s.pendingStart);
  const pendingFinish = useFlockStore((s) => s.pendingFinish);

  const flockId = useFlockStore((s) => s.flockId);
  const applyServerSession = useFlockStore((s) => s.applyServerSession);

  const participants = session?.participants ?? [];
  const routes = session?.computedRoutes ?? [];
  const sharedSegments = session?.sharedSegments ?? [];
  const flockRoute = session?.flockRoute ?? null;
  const waypoints = session?.waypoints ?? [];
  const locked = session?.lockedAt != null;
  const nameOf = (id: string) => participants.find((p) => p.id === id)?.name ?? "Someone";

  // Drag-to-move: a waypoint (shared, anyone) or a start pin you own. Leaflet has
  // already moved the marker; we persist the drop and the server echo re-pins it.
  // On failure we snap the marker back to `origin` (the store position) so the map
  // never shows a phantom location the server doesn't have.
  async function moveWaypoint(id: string, marker: L.Marker, origin: LatLng) {
    if (!flockId) return;
    const ll = marker.getLatLng();
    try {
      const updated = await updateWaypoint(flockId, id, { location: { lat: ll.lat, lng: ll.lng } });
      applyServerSession(updated, true);
      log.info("waypoint moved", { id: id.slice(0, 4), lat: round4(ll.lat), lng: round4(ll.lng) });
    } catch (err) {
      marker.setLatLng(toLeaflet(origin));
      log.error("waypoint move failed — reverted", { error: String(err) });
    }
  }
  async function moveStart(id: string, marker: L.Marker, origin: LatLng) {
    if (!flockId) return;
    const ll = marker.getLatLng();
    try {
      const updated = await updateParticipant(flockId, id, {
        startLocation: { lat: ll.lat, lng: ll.lng },
      });
      applyServerSession(updated, true);
      log.info("start moved", { id: id.slice(0, 4), lat: round4(ll.lat), lng: round4(ll.lng) });
    } catch (err) {
      marker.setLatLng(toLeaflet(origin));
      log.error("start move failed — reverted", { error: String(err) });
    }
  }

  // Collect every point that should influence the viewport. We frame the drawn
  // geometry (the flock route + everyone's routes), not just the start pins —
  // otherwise a long loop runs off-screen. Route geometry is reduced to its
  // bounding corners so FitBounds stays cheap (its signature is over `pts`).
  const allPoints = useMemo(() => {
    const pts: LatLng[] = [];
    for (const p of participants) {
      pts.push(p.startLocation);
      if (p.finishLocation) pts.push(p.finishLocation);
    }
    for (const w of waypoints) pts.push(w.location);
    if (pendingStart) pts.push(pendingStart);

    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    let any = false;
    const stretch = (lat: number, lng: number) => {
      any = true;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    };
    if (flockRoute) for (const [lng, lat] of flockRoute.coordinates) stretch(lat, lng);
    for (const r of routes) for (const [lng, lat] of r.geometry.coordinates) stretch(lat, lng);
    if (any) {
      pts.push({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng });
    }
    return pts;
  }, [participants, waypoints, pendingStart, flockRoute, routes]);

  // Direction-of-travel chevrons. When nothing is focused, they ride the flock
  // SPINE (the shared route's heading). When a runner is focused, they ride THAT
  // runner's full route instead (incl. their approach/egress feeders), and the
  // spine chevrons step aside so the focused line reads cleanly.
  const spineArrows = useMemo(
    () => (flockRoute ? arrowsAlong(flockRoute.coordinates, SPINE_ARROW_SPACING_M) : []),
    [flockRoute],
  );
  const focusedRoute = focus ? routes.find((r) => r.participantId === focus) : undefined;
  const focusedArrows = useMemo(
    () => (focusedRoute ? arrowsAlong(focusedRoute.geometry.coordinates, SPINE_ARROW_SPACING_M) : []),
    [focusedRoute],
  );

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        zoomControl={false}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="flock-tiles"
        />

        <ClickHandler />
        <CursorMode />
        <FitBounds points={allPoints} />

        {/* The Flock Route — the shared backbone spine the whole flock runs along.
            A wide soft-white casing laid BENEATH every other line, so the common
            route reads as one bright thread that the individual approach/egress
            legs branch off from (the white-to-routes relationship mirrors the
            black-casing-to-colour trick used per runner). */}
        {flockRoute && flockRoute.coordinates.length > 1 && (
          <>
            <Polyline
              key="flock-route-glow"
              positions={flockRoute.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{
                color: "#ffffff",
                weight: 34,
                opacity: 0.12,
                lineCap: "round",
                lineJoin: "round",
              }}
              interactive={false}
            />
            <Polyline
              key="flock-route-casing"
              positions={flockRoute.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{
                color: "#ffffff",
                weight: 22,
                opacity: 0.7,
                lineCap: "round",
                lineJoin: "round",
              }}
              interactive={false}
            />
          </>
        )}

        {/* Direction chevrons (non-interactive, below pins). Spine chevrons at rest;
            the focused runner's route chevrons when one is focused. */}
        {(focus ? focusedArrows : spineArrows).map((ar, i) => (
          <Marker
            key={`arrow-${i}`}
            position={[ar.lat, ar.lng]}
            icon={arrowIcon(ar.deg, focus != null)}
            interactive={false}
            zIndexOffset={-100}
          />
        ))}

        {/* Together overlay — the signature glowing underlay where the flock runs
            together (rendered BENEATH the routes). A wide soft halo + a brighter
            animated core. */}
        {sharedSegments.map((seg, i) => {
          const positions = seg.geometry.coordinates.map(
            ([lng, lat]) => [lat, lng] as [number, number],
          );
          const names = seg.participantIds.map(nameOf);
          const label = `${names.join(" + ")} flock together here for ~${Math.round(
            seg.overlapMinutes,
          )} min`;
          return (
            <Polyline
              key={`together-halo-${i}`}
              positions={positions}
              pathOptions={{
                color: "var(--together)",
                weight: 14,
                opacity: 0.28,
                lineCap: "round",
                lineJoin: "round",
                className: "together-glow",
              }}
            >
              <Tooltip sticky>{label}</Tooltip>
            </Polyline>
          );
        })}
        {sharedSegments.map((seg, i) => (
          <Polyline
            key={`together-core-${i}`}
            positions={seg.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
            pathOptions={{
              color: "var(--together)",
              weight: 4,
              opacity: 0.95,
              lineCap: "round",
              lineJoin: "round",
            }}
            interactive={false}
          />
        ))}

        {/* Routes are faint at rest; focusing a runner pops their line and recedes
            the rest. Only the focused line gets the dark casing (a clean outline);
            the faint ones stay thin colour-only so they don't muddy the map. */}
        {routes
          .filter((r) => focus === r.participantId)
          .map((r) => (
            <Polyline
              key={`casing-${r.participantId}`}
              positions={r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{
                color: "#0b0b0e",
                weight: 9,
                opacity: 0.8,
                lineCap: "round",
                lineJoin: "round",
              }}
              interactive={false}
            />
          ))}

        {routes.map((r) => {
            const p = participants.find((x) => x.id === r.participantId);
            const color = p?.color ?? "#fff";
            const isFocused = focus === r.participantId;
            // Faint at rest; the focused runner pops; the rest recede further when
            // one is focused so the focused line reads cleanly.
            const opacity = isFocused ? 1 : focus ? 0.16 : 0.32;
            const weight = isFocused ? 6 : 3;
            return (
            <Polyline
              key={r.participantId}
              positions={r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{
                color,
                weight,
                opacity,
                lineCap: "round",
                lineJoin: "round",
              }}
              eventHandlers={{
                mouseover: () => useFlockStore.getState().setHovered(r.participantId),
                mouseout: () => useFlockStore.getState().setHovered(null),
                click: () =>
                  useFlockStore
                    .getState()
                    .setSelected(selected === r.participantId ? null : r.participantId),
              }}
            >
              <Tooltip sticky>
                <span className="mono">{p?.name}</span> ·{" "}
                {formatDistance(r.distanceKm, session!.unitPreference)} · {r.departureTime}–
                {r.arrivalTime}
              </Tooltip>
            </Polyline>
          );
        })}

        {/* Meeting points — a diamond only where the flock genuinely grows (the
            rendezvous, a joiner, or two neighbours converging on a feeder). Legs
            where the set only shrinks (a peel-off) are drawn as together segments
            but aren't meetings, so they earn no diamond. Sessions computed before
            isConvergence existed lack the flag → treated as "show" (prior behaviour). */}
        {sharedSegments.map((seg, i) => {
          if (seg.isConvergence === false) return null;
          const first = seg.geometry.coordinates[0];
          if (!first) return null;
          const names = seg.participantIds.map(nameOf);
          return (
            <Marker
              key={`meet-${i}`}
              position={[first[1], first[0]]}
              icon={meetIcon()}
              zIndexOffset={500}
            >
              <Tooltip direction="top" offset={[0, -10]}>
                {names.join(" + ")} meet here · ~{seg.startTime}
              </Tooltip>
            </Marker>
          );
        })}

        {/* Participant markers — you can drag your own start to move it. */}
        {participants.map((p) => {
          const canDrag = !locked && !!flockId && ownsParticipant(flockId, p.id);
          return (
            <Marker
              key={`start-${p.id}`}
              position={toLeaflet(p.startLocation)}
              icon={divMarker(p.color, initial(p.name), "start", canDrag)}
              draggable={canDrag}
              eventHandlers={{
                mouseover: () => useFlockStore.getState().setHovered(p.id),
                mouseout: () => useFlockStore.getState().setHovered(null),
                click: () =>
                  useFlockStore.getState().setSelected(selected === p.id ? null : p.id),
                dragend: (e) => moveStart(p.id, e.target as L.Marker, p.startLocation),
              }}
            >
              <Tooltip direction="top" offset={[0, -16]}>
                <span className="mono">{p.name}</span>
                {(() => {
                  const r = routes.find((x) => x.participantId === p.id);
                  return r ? ` · ${formatDistance(r.distanceKm, session!.unitPreference)}` : "";
                })()}
                {canDrag ? " · drag to move" : ""}
              </Tooltip>
            </Marker>
          );
        })}
        {participants
          .filter((p) => p.finishLocation)
          .map((p) => (
            <Marker
              key={`finish-${p.id}`}
              position={toLeaflet(p.finishLocation!)}
              icon={divMarker(p.color, initial(p.name), "finish")}
            />
          ))}
        {/* Shared waypoints everyone routes through — anyone can drag to reposition. */}
        {waypoints.map((w, i) => (
          <Marker
            key={`wp-${w.id}`}
            position={toLeaflet(w.location)}
            icon={waypointIcon(i + 1, w.stopMinutes > 0, !locked)}
            draggable={!locked}
            zIndexOffset={400}
            eventHandlers={{
              dragend: (e) => moveWaypoint(w.id, e.target as L.Marker, w.location),
            }}
          >
            <Tooltip direction="top" offset={[0, -22]}>
              <span className="mono">{w.name}</span>
              {w.stopMinutes > 0 ? ` · ${w.stopMinutes} min stop` : ""}
              {!locked ? " · drag to move" : ""}
            </Tooltip>
          </Marker>
        ))}

        {/* In-progress start / finish pins from the open form */}
        {pendingStart && (
          <Marker
            position={toLeaflet(pendingStart)}
            icon={divMarker("var(--accent)", "+", "start")}
          />
        )}
        {pendingFinish && (
          <Marker
            position={toLeaflet(pendingFinish)}
            icon={divMarker("var(--accent)", "⚑", "finish")}
          />
        )}
      </MapContainer>

      {/* Gentle prompt when there isn't enough to compare yet */}
      {participants.filter((p) => p.startLocation).length < 2 && !session?.lockedAt && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-[500] -translate-x-1/2 rounded-full bg-surface-mid/90 px-4 py-2 text-xs text-text-dim shadow-panel backdrop-blur">
          Add another person to see where your routes overlap.
        </div>
      )}

      {/* Legend */}
      {participants.length > 0 && <Legend />}
    </div>
  );
}

function Legend() {
  const session = useFlockStore((s) => s.session);
  const selected = useFlockStore((s) => s.selectedParticipantId);
  const setSelected = useFlockStore((s) => s.setSelected);
  const setHovered = useFlockStore((s) => s.setHovered);
  if (!session) return null;
  const shared = session.sharedSegments ?? [];
  const flockRoute = session.flockRoute ?? null;
  const totalMin = Math.round(shared.reduce((s, x) => s + x.overlapMinutes, 0));
  const hasMeet = shared.some((s) => s.isConvergence !== false);

  return (
    <div className="absolute bottom-4 right-4 z-[500] max-w-[200px] rounded-xl border border-white/10 bg-surface-mid/90 p-3 text-xs shadow-panel backdrop-blur">
      <ul className="space-y-0.5">
        {session.participants.map((p) => {
          const active = selected === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelected(active ? null : p.id)}
                onMouseEnter={() => setHovered(p.id)}
                onMouseLeave={() => setHovered(null)}
                aria-pressed={active}
                title={active ? "Click to show all" : "Click to focus this route"}
                className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition hover:bg-white/5 ${active ? "bg-white/10" : ""}`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                <span className="truncate text-text">{p.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {/* Key for the map elements that aren't a person: the shared spine, the
          flocking glow, and the meet-up diamonds. */}
      {(flockRoute || shared.length > 0) && (
        <ul className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
          {flockRoute && (
            <li className="flex items-center gap-2">
              <span className="h-[3px] w-3.5 rounded-full bg-white/75" />
              <span className="text-fog">Flock route</span>
            </li>
          )}
          {shared.length > 0 && (
            <li className="flex items-center gap-2">
              <span
                className="h-[3px] w-3.5 rounded-full"
                style={{ background: "var(--together)" }}
              />
              <span className="text-fog">Flocking together</span>
            </li>
          )}
          {hasMeet && (
            <li className="flex items-center gap-2">
              <span
                className="ml-1 h-2 w-2 rotate-45"
                style={{ background: "var(--together)", boxShadow: "0 0 6px var(--together)" }}
              />
              <span className="text-fog">Meet-up</span>
            </li>
          )}
        </ul>
      )}
      <div className="mono mt-2 border-t border-white/10 pt-2 text-fog">
        {shared.length} together · {totalMin} min flocking
      </div>
    </div>
  );
}
