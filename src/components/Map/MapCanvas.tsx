"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  CircleMarker,
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
import { renameWaypoints } from "@/lib/flockApi";
import { isAutoWaypointName } from "@/lib/flockGpx";
import { pinLabel, reverseGeocode } from "@/lib/geocodeClient";
import { uUpdateParticipant, uUpdateWaypoint } from "@/lib/undoableEdits";
import { bearingRad, distanceMeters, toLeaflet } from "@/lib/geo";
import { createLogger } from "@/lib/logger";
import type { LatLng, LocationPin } from "@/lib/types";
import { formatDistance } from "@/lib/units";
import { isMobileViewport } from "@/lib/viewport";
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

/** A numbered pin for a shared waypoint (☕ if it has a stop). The teardrop is kept
    small (it was crowding the map on mobile) but sits inside a larger transparent
    box so it stays an easy tap / drag target. When `highlighted` (its panel row is
    hovered, or it's being edited) it swells and picks up a together-coloured halo. */
function waypointIcon(order: number, hasStop: boolean, draggable = false, highlighted = false): L.DivIcon {
  const cursor = draggable ? "cursor:grab;" : "";
  const T = highlighted ? 28 : 20; // visible teardrop
  const BOX = highlighted ? 44 : 32; // transparent hit area around it
  const border = highlighted ? "var(--together)" : "var(--accent)";
  const borderW = highlighted ? 3 : 2;
  const glow = highlighted
    ? "0 0 0 4px var(--together-glow),0 2px 10px rgba(0,0,0,0.6)"
    : "0 2px 6px rgba(0,0,0,0.5)";
  const fontSize = highlighted ? 13 : 10;
  return L.divIcon({
    className: "",
    html:
      `<div style="${cursor}display:flex;align-items:center;justify-content:center;width:${BOX}px;height:${BOX}px;">` +
      `<div style="display:flex;align-items:center;justify-content:center;` +
      `width:${T}px;height:${T}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);` +
      `background:var(--text);border:${borderW}px solid ${border};` +
      `box-shadow:${glow};">` +
      `<span style="transform:rotate(45deg);font-size:${fontSize}px;font-weight:600;color:#15151a;">` +
      `${hasStop ? "☕" : order}</span></div></div>`,
    iconSize: [BOX, BOX],
    iconAnchor: [BOX / 2, (BOX - T) / 2 + T * 0.92], // teardrop tip at the location
  });
}

/** Nearest vertex index on a [lng,lat] polyline to a point — used to slice the stretch of
    a runner's route that a hovered schedule row covers (squared-degree distance is fine at
    a city's scale). */
function nearestIdx(coords: [number, number][], ll: LatLng): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dx = coords[i][0] - ll.lng;
    const dy = coords[i][1] - ll.lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
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

/**
 * Track the live map viewport into the store on pan/zoom, so the address search
 * can bias autocomplete toward what the user is currently looking at (center =
 * Photon focus point; bounds = Nominatim-fallback viewbox).
 */
function ViewportTracker() {
  const setMapView = useFlockStore((s) => s.setMapView);
  const publish = useCallback(
    (map: L.Map) => {
      const c = map.getCenter();
      const b = map.getBounds();
      setMapView({
        center: { lat: c.lat, lng: c.lng },
        bounds: { minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast() },
      });
    },
    [setMapView],
  );
  const map = useMapEvents({
    moveend(e) {
      publish(e.target as L.Map);
    },
    zoomend(e) {
      publish(e.target as L.Map);
    },
  });
  // Seed the store with the initial view (no move event fires on first load).
  useEffect(() => publish(map), [map, publish]);
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
      // clicks). Priority order:
      const st = useFlockStore.getState();
      //  1. clear a route focus, if one is active;
      if (st.selectedParticipantId) {
        st.setSelected(null);
        return;
      }
      //  2. on DESKTOP, in the list view with nothing open, drop a waypoint here (the
      //     "tap empty map to add a waypoint" gesture). On mobile this is deliberately a
      //     button instead (the "+ Add a waypoint" flow), so a stray tap while panning the
      //     review map can't create an accidental waypoint.
      if (!isMobileViewport() && !st.formOpen && st.waypointEditor.mode === "closed" && st.session?.lockedAt == null) {
        log.debug("map click → append waypoint", { lat: ll.lat, lng: ll.lng });
        st.setWaypointPin(ll);
      }
    },
  });
  return null;
}

/**
 * Frame the map to the known points — but calmly. We only (re)frame when the
 * content isn't already comfortably in view, so the map respects wherever the
 * user has panned/zoomed and never yanks the viewport in response to their own
 * direct manipulation (dragging a pin), to routes recomputing a second later, or
 * to a polled change that's still on-screen. The viewport moves only when
 * something would otherwise sit off the edge: first load, a far-away join, or a
 * route that grew past the current view.
 */
function FitBounds({ points }: { points: LatLng[] }) {
  const map = useMap();
  const sig = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join("|");
  const lastSig = useRef("");
  const framedOnce = useRef(false);

  useEffect(() => {
    if (points.length === 0) return;
    if (sig === lastSig.current) return;
    lastSig.current = sig;

    const target = L.latLngBounds(points.map(toLeaflet));
    // Once we've framed at least once, leave the viewport alone as long as the
    // content still fits inside it (shrunk 8% so points hugging the edge still
    // count as "off-screen" and pull the view).
    if (framedOnce.current && map.getBounds().pad(-0.08).contains(target)) {
      log.debug("fit skipped — content in view", { count: points.length });
      return;
    }
    framedOnce.current = true;

    if (points.length === 1) {
      map.setView(toLeaflet(points[0]), 14, { animate: true });
    } else {
      map.fitBounds(target, { padding: [60, 60], maxZoom: 15, animate: true });
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

  // Panel-driven emphasis: a hovered (or being-edited) waypoint pops its marker; a hovered
  // schedule row lights up just that stretch of the runner's route.
  const hoveredWaypointId = useFlockStore((s) => s.hoveredWaypointId);
  const waypointEditor = useFlockStore((s) => s.waypointEditor);
  const hoveredSegment = useFlockStore((s) => s.hoveredSegment);
  const highlightWaypointId =
    hoveredWaypointId ?? (waypointEditor.mode === "edit" ? waypointEditor.id : null);

  const flockId = useFlockStore((s) => s.flockId);

  // Stable [lat,lng] identity per marker. react-leaflet re-applies a Marker's
  // `position` (marker.setLatLng) only when the prop changes BY REFERENCE — and
  // toLeaflet() builds a fresh array every render, so ANY re-render during a drag
  // (a 5s poll, a recalc finishing, a hover) snapped the marker back to the store
  // position mid-gesture. Returning the SAME array while the coords are unchanged
  // makes react-leaflet skip setLatLng, so an in-flight drag is never yanked; a
  // genuine move (the server echo after dragend) yields a new array and re-pins.
  const posCacheRef = useRef<Map<string, [number, number]>>(new Map());
  const stablePos = (key: string, ll: LatLng): [number, number] => {
    const prev = posCacheRef.current.get(key);
    if (prev && prev[0] === ll.lat && prev[1] === ll.lng) return prev;
    const next: [number, number] = [ll.lat, ll.lng];
    posCacheRef.current.set(key, next);
    return next;
  };

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
  async function moveWaypoint(id: string, marker: L.Marker, origin: LatLng, currentName: string) {
    if (!flockId) return;
    const ll = marker.getLatLng();
    try {
      await uUpdateWaypoint(flockId, id, { location: { lat: ll.lat, lng: ll.lng } });
      log.info("waypoint moved", { id: id.slice(0, 4), lat: round4(ll.lat), lng: round4(ll.lng) });
      // An auto-named pin's place label belongs to the OLD spot — re-derive it for the new
      // location. Skip user-typed names. Run AFTER the move write so the two patches can't race;
      // renameWaypoints does NOT recompute the route and the server re-guards on isAutoWaypointName
      // at write time, so a name a user (or another device) set meanwhile is never clobbered.
      if (isAutoWaypointName(currentName) || currentName === "Dropped pin") {
        const label = pinLabel(await reverseGeocode(ll.lat, ll.lng));
        if (label) await renameWaypoints(flockId, { [id]: { name: label, address: label } });
      }
    } catch (err) {
      marker.setLatLng(toLeaflet(origin));
      log.error("waypoint move failed — reverted", { error: String(err) });
    }
  }
  // A runner has a personal map marker only when their start/finish is a MANUAL pin —
  // "no preference" and "at a waypoint" carry no separate marker.
  const pinLoc = (pin: LocationPin): LatLng | null => (pin.kind === "manual" ? pin.location : null);

  async function moveStart(id: string, marker: L.Marker, origin: LatLng) {
    if (!flockId) return;
    const ll = marker.getLatLng();
    try {
      await uUpdateParticipant(flockId, id, { startPin: { kind: "manual", location: { lat: ll.lat, lng: ll.lng }, address: "" } }, "Move start");
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
      const sl = pinLoc(p.startPin);
      if (sl) pts.push(sl);
      const fl = pinLoc(p.finishPin);
      if (fl) pts.push(fl);
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

  // The map geometry for a hovered schedule row: slice the runner's route between the
  // segment's start/end points. A rest (the coffee stop) is a single point, drawn as a
  // pulsing ring instead of a line.
  const segmentHighlight = useMemo(() => {
    if (!hoveredSegment) return null;
    const r = routes.find((x) => x.participantId === hoveredSegment.participantId);
    const seg = r?.schedule[hoveredSegment.index];
    if (!r || !seg) return null;
    const coords = r.geometry.coordinates as [number, number][];
    const a = nearestIdx(coords, seg.startLocation);
    const b = nearestIdx(coords, seg.endLocation);
    const slice = coords.slice(Math.min(a, b), Math.max(a, b) + 1);
    const color = participants.find((p) => p.id === r.participantId)?.color ?? "#ffffff";
    if (slice.length >= 2) {
      return { kind: "line" as const, positions: slice.map(([lng, lat]) => [lat, lng] as [number, number]), color };
    }
    return { kind: "point" as const, position: [seg.startLocation.lat, seg.startLocation.lng] as [number, number], color };
  }, [hoveredSegment, routes, participants]);

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
        <ViewportTracker />
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
            // one is focused so the focused line reads cleanly. At-rest lines are a
            // touch thicker (5) and slightly more opaque than the receded ones (3)
            // so individual feeder paths to/from the flock read when nothing is selected.
            const opacity = isFocused ? 1 : focus ? 0.16 : 0.42;
            const weight = isFocused ? 6 : focus ? 3 : 5;
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

        {/* Schedule-row emphasis — a bright cased overlay (or a ring, at a stop) on just the
            stretch the hovered schedule row covers. Drawn above the routes, below the pins. */}
        {segmentHighlight?.kind === "line" && (
          <>
            <Polyline
              key="seg-highlight-casing"
              positions={segmentHighlight.positions}
              pathOptions={{ color: "#ffffff", weight: 11, opacity: 0.85, lineCap: "round", lineJoin: "round" }}
              interactive={false}
            />
            <Polyline
              key="seg-highlight-core"
              positions={segmentHighlight.positions}
              pathOptions={{ color: segmentHighlight.color, weight: 6, opacity: 1, lineCap: "round", lineJoin: "round" }}
              interactive={false}
            />
          </>
        )}
        {segmentHighlight?.kind === "point" && (
          <CircleMarker
            center={segmentHighlight.position}
            radius={13}
            pathOptions={{ color: "var(--together)", weight: 3, fillColor: "var(--together)", fillOpacity: 0.25 }}
            interactive={false}
          />
        )}

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

        {/* Participant markers — tapping your OWN opens you for editing (same as
            tapping a waypoint), and you can drag it to move your start. Tapping
            someone else's (or anyone's once locked) just focuses their route. */}
        {participants.map((p) => {
          const loc = pinLoc(p.startPin);
          if (!loc) return null;
          const canDrag = !locked && !!flockId && ownsParticipant(flockId, p.id);
          return (
            <Marker
              key={`start-${p.id}`}
              position={stablePos(`start-${p.id}`, loc)}
              icon={divMarker(p.color, initial(p.name), "start", canDrag)}
              draggable={canDrag}
              eventHandlers={{
                mouseover: () => useFlockStore.getState().setHovered(p.id),
                mouseout: () => useFlockStore.getState().setHovered(null),
                dragend: (e) => {
                  const m = e.target as L.Marker;
                  const ll = m.getLatLng();
                  // Leaflet fires dragend once the pointer moves ≥3 px; treat only a
                  // >3 m ground move as a real reposition. A sub-3 m "drag" is a tap
                  // with finger jitter — snap back and open the editor right here,
                  // because Leaflet swallows the click that would otherwise follow.
                  const moved = distanceMeters(loc, { lat: ll.lat, lng: ll.lng }) > 3;
                  if (moved) {
                    void moveStart(p.id, m, loc);
                  } else {
                    m.setLatLng(toLeaflet(loc));
                    if (canDrag) useFlockStore.getState().openEditForm(p.id);
                  }
                },
                click: () => {
                  // A clean tap — Leaflet suppresses the click after any drag, so this
                  // only runs for a real tap. Your own pin → edit you; anyone else's →
                  // focus their route.
                  if (canDrag) useFlockStore.getState().openEditForm(p.id);
                  else useFlockStore.getState().setSelected(selected === p.id ? null : p.id);
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -16]}>
                <span className="mono">{p.name}</span>
                {(() => {
                  const r = routes.find((x) => x.participantId === p.id);
                  return r ? ` · ${formatDistance(r.distanceKm, session!.unitPreference)}` : "";
                })()}
                {canDrag ? " · tap to edit · drag to move" : ""}
              </Tooltip>
            </Marker>
          );
        })}
        {participants
          .map((p) => ({ p, loc: pinLoc(p.finishPin) }))
          .filter((x): x is { p: typeof x.p; loc: LatLng } => x.loc != null)
          .map(({ p, loc }) => (
            <Marker
              key={`finish-${p.id}`}
              position={toLeaflet(loc)}
              icon={divMarker(p.color, initial(p.name), "finish")}
            />
          ))}
        {/* Shared waypoints everyone routes through — anyone can drag to reposition. */}
        {waypoints.map((w, i) => (
          <Marker
            key={`wp-${w.id}`}
            position={stablePos(`wp-${w.id}`, w.location)}
            icon={waypointIcon(i + 1, w.stopMinutes > 0, !locked, highlightWaypointId === w.id)}
            draggable={!locked}
            zIndexOffset={highlightWaypointId === w.id ? 600 : 400}
            eventHandlers={{
              dragend: (e) => {
                const m = e.target as L.Marker;
                const ll = m.getLatLng();
                // >3 m = a real reposition; a sub-3 m "drag" is a jittery tap, so snap
                // back and open the editor here (Leaflet eats the post-drag click).
                const moved = distanceMeters(w.location, { lat: ll.lat, lng: ll.lng }) > 3;
                if (moved) {
                  void moveWaypoint(w.id, m, w.location, w.name);
                } else {
                  m.setLatLng(toLeaflet(w.location));
                  if (!locked) useFlockStore.getState().openEditWaypoint(w.id);
                }
              },
              click: () => {
                // A clean tap (Leaflet suppresses the click after a drag).
                if (!locked) useFlockStore.getState().openEditWaypoint(w.id);
              },
            }}
          >
            <Tooltip direction="top" offset={[0, -22]}>
              <span className="mono">{w.name}</span>
              {w.stopMinutes > 0 ? ` · ${w.stopMinutes} min stop` : ""}
              {!locked ? " · tap to edit · drag to move" : ""}
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
      {participants.length < 2 && !session?.lockedAt && (
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
    <div className="absolute bottom-[calc(4.5rem_+_env(safe-area-inset-bottom))] right-4 z-[500] max-w-[200px] rounded-xl border border-white/15 bg-surface-mid p-3 text-xs shadow-panel md:bottom-4">
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
              <span className="text-text-dim">Flock route</span>
            </li>
          )}
          {shared.length > 0 && (
            <li className="flex items-center gap-2">
              <span
                className="h-[3px] w-3.5 rounded-full"
                style={{ background: "var(--together)" }}
              />
              <span className="text-text-dim">Flocking together</span>
            </li>
          )}
          {hasMeet && (
            <li className="flex items-center gap-2">
              <span
                className="ml-1 h-2 w-2 rotate-45"
                style={{ background: "var(--together)", boxShadow: "0 0 6px var(--together)" }}
              />
              <span className="text-text-dim">Meet-up</span>
            </li>
          )}
        </ul>
      )}
      <div className="mono mt-2 border-t border-white/10 pt-2 text-text-dim">
        {shared.length} together · {totalMin} min flocking
      </div>
    </div>
  );
}
