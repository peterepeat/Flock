"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef } from "react";
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

import PartyController from "@/components/Party/PartyController";
import { initial } from "@/lib/colors";
import { isPartyActive } from "@/lib/party/simulate";
import { renameWaypoints } from "@/lib/flockApi";
import { waypointNameIsAuto } from "@/lib/flockGpx";
import { pinLabel, reverseGeocode } from "@/lib/geocodeClient";
import { uAddWaypoint, uUpdateParticipant, uUpdateWaypoint } from "@/lib/undoableEdits";
import { bearingRad, distanceMeters, toLeaflet } from "@/lib/geo";
import { createLogger } from "@/lib/logger";
import { insertionIndex } from "@/lib/routeEdit";
import type { FlockWaypoint, LatLng, LocationPin } from "@/lib/types";
import { formatDistance } from "@/lib/units";
import { isMobileViewport } from "@/lib/viewport";
import { useFlockStore, useUnit } from "@/store/flockStore";

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

// The dot that follows the cursor while reshaping the route (created once).
const GHOST_ICON = L.divIcon({
  className: "",
  html: `<div style="width:18px;height:18px;border-radius:50%;background:var(--accent);border:3px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.55)"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});
// Pointer travel (px) below which a press-release is treated as a click, not a drag
// — so a stray click on the line never drops a waypoint.
const DRAG_COMMIT_PX = 6;

type GrabRef = MutableRefObject<((e: L.LeafletMouseEvent) => void) | null>;

/**
 * Drag-to-reshape. Grab the flock route ANYWHERE and pull; on release a new waypoint
 * is dropped at that point, spliced into the right ORDER position (insertionIndex),
 * so the corridor bends through it on the next recompute. A ghost dot tracks the
 * cursor once the drag commits (a sub-threshold press stays a click).
 *
 * A transparent "grab" line over the spine captures the gesture where only the spine
 * shows; the SAME handler (exposed via `grabRef`) is also attached to the per-runner
 * route + together-halo polylines, so reshaping works even when one of THOSE is on
 * top (e.g. a focused runner's line) — without stealing their hover/click/tooltip.
 * Inactive while locked or while placing a pin.
 */
function RouteEditor({ grabRef, suppressClickRef }: { grabRef: GrabRef; suppressClickRef: MutableRefObject<number> }) {
  const map = useMap();
  const flockId = useFlockStore((s) => s.flockId);
  const session = useFlockStore((s) => s.session);
  const placing = useFlockStore((s) => s.placingPin || s.placingFinish || s.placingWaypoint);

  const flockRoute = session?.flockRoute ?? null;
  const routeLocked = session?.locks?.route ?? false;
  const spine = useMemo<LatLng[]>(
    () => (flockRoute ? flockRoute.coordinates.map(([lng, lat]) => ({ lat, lng })) : []),
    [flockRoute],
  );
  const active = !!flockRoute && spine.length >= 2 && !routeLocked && !placing;

  // Live data the imperative drag handlers read — held in a ref so the handlers we
  // add to the map are STABLE (matched on remove) yet never read stale state.
  const ctx = useRef<{ flockId: string | null; spine: LatLng[]; waypoints: { location: LatLng }[]; active: boolean }>({
    flockId: null,
    spine: [],
    waypoints: [],
    active: false,
  });
  ctx.current = { flockId, spine, waypoints: session?.waypoints ?? [], active };

  const dragging = useRef(false);
  const committed = useRef(false); // crossed the px threshold → a real drag, not a click
  const ghost = useRef<L.Marker | null>(null);
  const downPt = useRef<L.Point | null>(null);
  const insertAt = useRef(0);

  // Stable map listeners that delegate to the latest closure via refs.
  const moveRef = useRef<(e: L.LeafletMouseEvent) => void>(() => {});
  const upRef = useRef<(e: L.LeafletMouseEvent) => void>(() => {});
  const stableMove = useRef((e: L.LeafletMouseEvent) => moveRef.current(e)).current;
  const stableUp = useRef((e: L.LeafletMouseEvent) => upRef.current(e)).current;

  const teardown = () => {
    map.off("mousemove", stableMove);
    map.off("mouseup", stableUp);
    map.dragging.enable();
    if (ghost.current) {
      map.removeLayer(ghost.current);
      ghost.current = null;
    }
    dragging.current = false;
    committed.current = false;
    downPt.current = null;
  };

  moveRef.current = (e) => {
    if (!dragging.current) return;
    if (!committed.current) {
      // Hold off until the pointer travels past the threshold, so a click (to select
      // a runner) never spawns a ghost or drops a waypoint. The ghost appears here.
      if (!downPt.current || e.containerPoint.distanceTo(downPt.current) < DRAG_COMMIT_PX) return;
      committed.current = true;
      ghost.current = L.marker(e.latlng, { icon: GHOST_ICON, interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map);
    }
    ghost.current?.setLatLng(e.latlng);
  };
  upRef.current = async (e) => {
    if (!dragging.current) return;
    const wasDrag = committed.current;
    const { flockId: fid } = ctx.current;
    const at = insertAt.current;
    teardown();
    if (!wasDrag) return; // a click — leave it to the layer's own click handler
    suppressClickRef.current = Date.now() + 400; // don't let the post-drag click select a runner
    if (!fid) return;
    const ll: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
    try {
      await uAddWaypoint(fid, { location: ll, address: "", name: "Dropped pin", stopMinutes: 0, autoNamed: true }, at);
      log.info("route reshaped → waypoint inserted", { index: at, lat: round4(ll.lat), lng: round4(ll.lng) });
      // Name it from its place like a tapped pin (best-effort; keeps the placeholder otherwise).
      const label = pinLabel(await reverseGeocode(ll.lat, ll.lng));
      if (label) {
        const w = (useFlockStore.getState().session?.waypoints ?? []).find(
          (x) =>
            x.name === "Dropped pin" &&
            Math.abs(x.location.lat - ll.lat) < 1e-9 &&
            Math.abs(x.location.lng - ll.lng) < 1e-9,
        );
        if (w) await renameWaypoints(fid, { [w.id]: { name: label, address: label } });
      }
    } catch (err) {
      log.error("route reshape insert failed", { error: String(err) });
    }
  };

  // The grab handler — attached to the spine grab line below AND (via grabRef) to the
  // route/halo polylines that may sit on top of it. We don't stop the event: panning is
  // prevented by disabling map.dragging, and letting it through preserves a layer's own
  // click (select a runner) when the press turns out to be a click, not a drag.
  const onDown = (e: L.LeafletMouseEvent) => {
    if (dragging.current || !ctx.current.active) return;
    const { spine: sp, waypoints } = ctx.current;
    if (sp.length < 2) return;
    dragging.current = true;
    committed.current = false;
    downPt.current = e.containerPoint;
    insertAt.current = insertionIndex(sp, waypoints, { lat: e.latlng.lat, lng: e.latlng.lng });
    map.dragging.disable();
    map.on("mousemove", stableMove);
    map.on("mouseup", stableUp);
  };
  grabRef.current = onDown;

  // Clean up listeners / re-enable panning if we unmount mid-gesture.
  useEffect(
    () => () => {
      map.off("mousemove", stableMove);
      map.off("mouseup", stableUp);
      grabRef.current = null;
      if (dragging.current) {
        map.dragging.enable();
        if (ghost.current) map.removeLayer(ghost.current);
      }
    },
    [map, stableMove, stableUp, grabRef],
  );

  if (!active) return null;
  return (
    <Polyline
      positions={spine.map((p) => [p.lat, p.lng] as [number, number])}
      pathOptions={{ className: "route-grab", color: "#000", opacity: 0, weight: 26, lineCap: "round", lineJoin: "round" }}
      eventHandlers={{ mousedown: onDown }}
    />
  );
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
      if (!isMobileViewport() && !st.formOpen && st.waypointEditor.mode === "closed" && !st.session?.locks?.route) {
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
  const unit = useUnit();
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
  // Advisory section locks govern map editing: route ops gate on the route lock; a
  // start pin gates on the runners section + that runner's own lock (no ownership).
  const routeLocked = session?.locks?.route ?? false;
  const runnersLocked = session?.locks?.runners ?? false;
  const runnerLocks = session?.runnerLocks ?? {};
  const nameOf = (id: string) => participants.find((p) => p.id === id)?.name ?? "Someone";

  // Drag-to-reshape plumbing (see RouteEditor): the route/together polylines that can
  // sit ON TOP of the spine forward their mousedown to the editor's grab handler, so a
  // drag reshapes even there. suppressClickRef swallows the click that the browser fires
  // right after a committed drag, so reshaping a runner's line doesn't also select them.
  const routeGrabRef = useRef<((e: L.LeafletMouseEvent) => void) | null>(null);
  const suppressClickRef = useRef(0);
  const onGrabRoute = useCallback((e: L.LeafletMouseEvent) => routeGrabRef.current?.(e), []);

  // Drag-to-move: a waypoint (shared, anyone) or a start pin you own. Leaflet has
  // already moved the marker; we persist the drop and the server echo re-pins it.
  // On failure we snap the marker back to `origin` (the store position) so the map
  // never shows a phantom location the server doesn't have.
  async function moveWaypoint(id: string, marker: L.Marker, origin: FlockWaypoint) {
    if (!flockId) return;
    const ll = marker.getLatLng();
    try {
      await uUpdateWaypoint(flockId, id, { location: { lat: ll.lat, lng: ll.lng } });
      log.info("waypoint moved", { id: id.slice(0, 4), lat: round4(ll.lat), lng: round4(ll.lng) });
      // An auto-named pin's place label belongs to the OLD spot — re-derive it for the new
      // location. Skip user-named pins. Run AFTER the move write so the two patches can't race;
      // renameWaypoints does NOT recompute the route and the server re-guards on waypointNameIsAuto
      // at write time, so a name a user (or another device) set meanwhile is never clobbered.
      if (waypointNameIsAuto(origin)) {
        const label = pinLabel(await reverseGeocode(ll.lat, ll.lng));
        if (label) await renameWaypoints(flockId, { [id]: { name: label, address: label } });
      }
    } catch (err) {
      marker.setLatLng(toLeaflet(origin.location));
      log.error("waypoint move failed — reverted", { error: String(err) });
    }
  }
  // A runner has a personal map marker only when their start/finish is a MANUAL pin —
  // "no preference" and "at a waypoint" carry no separate marker.
  const pinLoc = (pin: LocationPin): LatLng | null => (pin.kind === "manual" ? pin.location : null);

  async function moveStart(id: string, marker: L.Marker, origin: LatLng) {
    if (!flockId) return;
    const ll = marker.getLatLng();
    const loc = { lat: ll.lat, lng: ll.lng };
    // Name the new spot FIRST so the move persists in ONE write — updateParticipant
    // recomputes, so a second cosmetic write would burn another route calc. The pin's
    // address is purely locational, so always refresh it to where it now sits (a slow /
    // failed lookup just leaves it blank). reverseGeocode never throws.
    const address = pinLabel(await reverseGeocode(loc.lat, loc.lng)) ?? "";
    try {
      await uUpdateParticipant(flockId, id, { startPin: { kind: "manual", location: loc, address } }, "Move start");
      log.info("start moved", { id: id.slice(0, 4), lat: round4(loc.lat), lng: round4(loc.lng), named: !!address });
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

        {/* Grab-anywhere reshape handle over the spine (transparent; just above the
            non-interactive casing, below the together-halos/routes so their tooltips
            survive). Drag a point off the line to splice a waypoint in. The route +
            halo polylines forward their own mousedown to it (onGrabRoute) so dragging
            works even where one of them sits on top of the spine. */}
        <RouteEditor grabRef={routeGrabRef} suppressClickRef={suppressClickRef} />

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
              eventHandlers={{ mousedown: onGrabRoute }}
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
            // Clearly visible at rest; the focused runner still pops (heaviest + its dark casing);
            // the rest recede when one is focused but stay legible. There's plenty of headroom before
            // the non-selected lines distract from the selected one, so keep them readable.
            const opacity = isFocused ? 1 : focus ? 0.4 : 0.7;
            const weight = isFocused ? 7 : focus ? 4 : 5.5;
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
                mousedown: onGrabRoute, // a drag here reshapes the route (RouteEditor)
                mouseover: () => useFlockStore.getState().setHovered(r.participantId),
                mouseout: () => useFlockStore.getState().setHovered(null),
                click: () => {
                  if (Date.now() < suppressClickRef.current) return; // just-finished a reshape drag
                  useFlockStore
                    .getState()
                    .setSelected(selected === r.participantId ? null : r.participantId);
                },
              }}
            >
              <Tooltip sticky>
                <span className="mono">{p?.name}</span> ·{" "}
                {formatDistance(r.distanceKm, unit)} · {r.departureTime}–
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

        {/* Participant markers — anyone may drag a runner's start to move it (and tap
            to edit them) unless the runners section or that runner is locked; a locked
            runner's pin just focuses their route. */}
        {participants.map((p) => {
          const loc = pinLoc(p.startPin);
          if (!loc) return null;
          const canDrag = !!flockId && !runnersLocked && !runnerLocks[p.id];
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
                  return r ? ` · ${formatDistance(r.distanceKm, unit)}` : "";
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
            icon={waypointIcon(i + 1, w.stopMinutes > 0, !routeLocked, highlightWaypointId === w.id)}
            draggable={!routeLocked}
            zIndexOffset={highlightWaypointId === w.id ? 600 : 400}
            eventHandlers={{
              dragend: (e) => {
                const m = e.target as L.Marker;
                const ll = m.getLatLng();
                // >3 m = a real reposition; a sub-3 m "drag" is a jittery tap, so snap
                // back and open the editor here (Leaflet eats the post-drag click).
                const moved = distanceMeters(w.location, { lat: ll.lat, lng: ll.lng }) > 3;
                if (moved) {
                  void moveWaypoint(w.id, m, w);
                } else {
                  m.setLatLng(toLeaflet(w.location));
                  if (!routeLocked) useFlockStore.getState().openEditWaypoint(w.id);
                }
              },
              click: () => {
                // A clean tap (Leaflet suppresses the click after a drag).
                if (!routeLocked) useFlockStore.getState().openEditWaypoint(w.id);
              },
            }}
          >
            <Tooltip direction="top" offset={[0, -22]}>
              <span className="mono">{w.name}</span>
              {w.stopMinutes > 0 ? ` · ${w.stopMinutes} min stop` : ""}
              {!routeLocked ? " · tap to edit · drag to move" : ""}
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

        {/* Flock Party — a self-contained, read-only disco replay of the plan. Lives
            inside the map (needs useMap) but never touches the model or the store's
            plan; it only paints over what's already computed. */}
        <PartyController />
      </MapContainer>

      {/* Gentle prompt when there isn't enough to compare yet */}
      {participants.length < 2 && !runnersLocked && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-[500] -translate-x-1/2 rounded-full bg-surface-mid/90 px-4 py-2 text-xs text-text-dim shadow-panel backdrop-blur">
          Add another person to see where your routes overlap.
        </div>
      )}

      {/* Legend — hidden during the party (we already know who's who) so the replay reads cleanly. */}
      {participants.length > 0 && !isPartyActive(session) && <Legend />}
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
