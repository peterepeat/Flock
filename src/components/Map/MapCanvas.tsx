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

/** Click-to-place handler for the start pin while the form is open. */
function ClickHandler() {
  const placingPin = useFlockStore((s) => s.placingPin);
  const formOpen = useFlockStore((s) => s.formOpen);
  const setDraftStart = useFlockStore((s) => s.setDraftStart);

  useMapEvents({
    click(e) {
      if (formOpen && placingPin) {
        const ll: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
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

  const participants = session?.participants ?? [];
  const routes = session?.computedRoutes ?? [];

  // Collect every point that should influence the viewport.
  const allPoints = useMemo(() => {
    const pts: LatLng[] = [];
    for (const p of participants) {
      pts.push(p.startLocation);
      if (p.finishLocation) pts.push(p.finishLocation);
      if (p.restStop?.location) pts.push(p.restStop.location);
    }
    if (pendingStart) pts.push(pendingStart);
    return pts;
  }, [participants, pendingStart]);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        zoomControl={false}
        className="h-full w-full"
        style={{ cursor: placingPin ? "crosshair" : "" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="flock-tiles"
        />

        <ClickHandler />
        <FitBounds points={allPoints} />

        {/* Routes (populated from build step 5+). */}
        {routes.map((r) => {
          const color = participants.find((p) => p.id === r.participantId)?.color ?? "#fff";
          const dim = hovered && hovered !== r.participantId;
          return (
            <Polyline
              key={r.participantId}
              positions={r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{ color, weight: 3, opacity: dim ? 0.25 : hovered === r.participantId ? 1 : 0.6 }}
            />
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
        {participants
          .filter((p) => p.restStop?.location)
          .map((p) => (
            <Marker
              key={`rest-${p.id}`}
              position={toLeaflet(p.restStop!.location!)}
              icon={divMarker(p.color, "☕", "rest")}
            />
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
        {shared.length} together · {totalMin} min flying
      </div>
    </div>
  );
}
