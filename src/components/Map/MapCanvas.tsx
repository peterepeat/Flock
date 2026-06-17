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
import { toLeaflet } from "@/lib/geo";
import { createLogger } from "@/lib/logger";
import type { LatLng } from "@/lib/types";
import { formatDistance } from "@/lib/units";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("map");

// Default view: Melbourne (matches the spec's example geography).
const DEFAULT_CENTER: [number, number] = [-37.8136, 144.9631];
const DEFAULT_ZOOM = 13;

type MarkerKind = "start" | "finish" | "rest";

function divMarker(color: string, label: string, kind: MarkerKind): L.DivIcon {
  const size = kind === "start" ? 30 : kind === "finish" ? 26 : 28;
  const anchor = size / 2;
  return L.divIcon({
    className: "", // drop leaflet's default white box
    html: `<div class="flock-marker flock-marker--${kind}" style="background:${color}">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
  });
}

/** A numbered pin for a shared waypoint (☕ if it has a stop). */
function waypointIcon(order: number, hasStop: boolean): L.DivIcon {
  return L.divIcon({
    className: "",
    html:
      `<div style="display:flex;align-items:center;justify-content:center;` +
      `width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);` +
      `background:var(--text);border:2px solid var(--accent);` +
      `box-shadow:0 2px 8px rgba(0,0,0,0.5);">` +
      `<span style="transform:rotate(45deg);font-size:12px;font-weight:600;color:#15151a;">` +
      `${hasStop ? "☕" : order}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 24],
  });
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

/** Click-to-place handler for the start pin or a shared waypoint. */
function ClickHandler() {
  const placingPin = useFlockStore((s) => s.placingPin);
  const formOpen = useFlockStore((s) => s.formOpen);
  const setDraftStart = useFlockStore((s) => s.setDraftStart);
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
      if (formOpen && placingPin) {
        log.debug("map click → start pin", { lat: ll.lat, lng: ll.lng });
        setDraftStart(ll);
      }
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
  const pendingStart = useFlockStore((s) => s.pendingStart);
  const placingPin = useFlockStore((s) => s.placingPin);
  const placingWaypoint = useFlockStore((s) => s.placingWaypoint);

  const participants = session?.participants ?? [];
  const routes = session?.computedRoutes ?? [];
  const sharedSegments = session?.sharedSegments ?? [];
  const flockRoute = session?.flockRoute ?? null;
  const waypoints = session?.waypoints ?? [];
  const nameOf = (id: string) => participants.find((p) => p.id === id)?.name ?? "Someone";

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

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        zoomControl={false}
        className="h-full w-full"
        style={{ cursor: placingPin || placingWaypoint ? "crosshair" : "" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="flock-tiles"
        />

        <ClickHandler />
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

        {/* Route casings — a dark outline under every route so the colours read
            clearly against busy map tiles. */}
        {routes.map((r) => {
          const dim = hovered && hovered !== r.participantId;
          return (
            <Polyline
              key={`casing-${r.participantId}`}
              positions={r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{
                color: "#0b0b0e",
                weight: 8,
                opacity: dim ? 0.25 : 0.75,
                lineCap: "round",
                lineJoin: "round",
              }}
              interactive={false}
            />
          );
        })}

        {/* Individual routes (colour cores) */}
        {routes.map((r) => {
          const p = participants.find((x) => x.id === r.participantId);
          const color = p?.color ?? "#fff";
          const isHover = hovered === r.participantId;
          const dim = hovered && !isHover;
          return (
            <Polyline
              key={r.participantId}
              positions={r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{
                color,
                weight: isHover ? 6 : 4.5,
                opacity: dim ? 0.3 : 1,
                lineCap: "round",
                lineJoin: "round",
              }}
              eventHandlers={{
                mouseover: () => useFlockStore.getState().setHovered(r.participantId),
                mouseout: () => useFlockStore.getState().setHovered(null),
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

        {/* Meeting points — only where the flock converges (start of each
            together-period). */}
        {sharedSegments.map((seg, i) => {
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

        {/* Participant markers */}
        {participants.map((p) => (
          <Marker
            key={`start-${p.id}`}
            position={toLeaflet(p.startLocation)}
            icon={divMarker(p.color, initial(p.name), "start")}
            eventHandlers={{
              mouseover: () => useFlockStore.getState().setHovered(p.id),
              mouseout: () => useFlockStore.getState().setHovered(null),
            }}
          >
            <Tooltip direction="top" offset={[0, -16]}>
              <span className="mono">{p.name}</span>
              {(() => {
                const r = routes.find((x) => x.participantId === p.id);
                return r ? ` · ${formatDistance(r.distanceKm, session!.unitPreference)}` : "";
              })()}
            </Tooltip>
          </Marker>
        ))}
        {participants
          .filter((p) => p.finishLocation)
          .map((p) => (
            <Marker
              key={`finish-${p.id}`}
              position={toLeaflet(p.finishLocation!)}
              icon={divMarker(p.color, initial(p.name), "finish")}
            />
          ))}
        {/* Shared waypoints everyone routes through */}
        {waypoints.map((w, i) => (
          <Marker
            key={`wp-${w.id}`}
            position={toLeaflet(w.location)}
            icon={waypointIcon(i + 1, w.stopMinutes > 0)}
            zIndexOffset={400}
          >
            <Tooltip direction="top" offset={[0, -22]}>
              <span className="mono">{w.name}</span>
              {w.stopMinutes > 0 ? ` · ${w.stopMinutes} min stop` : ""}
            </Tooltip>
          </Marker>
        ))}

        {/* In-progress start pin from the open form */}
        {pendingStart && (
          <Marker
            position={toLeaflet(pendingStart)}
            icon={divMarker("var(--accent)", "+", "start")}
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
  if (!session) return null;
  const shared = session.sharedSegments ?? [];
  const totalMin = Math.round(shared.reduce((s, x) => s + x.overlapMinutes, 0));

  return (
    <div className="absolute bottom-4 right-4 z-[500] max-w-[200px] rounded-xl border border-white/10 bg-surface-mid/90 p-3 text-xs shadow-panel backdrop-blur">
      <ul className="space-y-1.5">
        {session.participants.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
            <span className="truncate text-text">{p.name}</span>
          </li>
        ))}
      </ul>
      <div className="mono mt-2 border-t border-white/10 pt-2 text-fog">
        {shared.length} together · {totalMin} min flocking
      </div>
    </div>
  );
}
