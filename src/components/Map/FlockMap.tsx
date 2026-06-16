"use client";

import dynamic from "next/dynamic";

// Leaflet touches `window`, so the canvas must never render on the server.
const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#0e0e10]">
      <span className="text-sm text-fog">Loading the map…</span>
    </div>
  ),
});

export default function FlockMap() {
  return <MapCanvas />;
}
