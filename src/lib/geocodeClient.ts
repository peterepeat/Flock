// ---------------------------------------------------------------------------
// Client-side geocoding helpers (browser). The forward autocomplete fetch lives
// inline in AddressSearch; this is the reverse lookup used to auto-name a pin a
// user just tapped onto the map (start/finish/waypoint).
// ---------------------------------------------------------------------------

import { createLogger } from "./logger";
import type { ReverseGeocodeResult } from "./types";

const log = createLogger("geocode-client");

/**
 * Name a tapped point. Returns a nearby POI name and/or the nearest address, or
 * null if the lookup fails (the caller then keeps the plain "Dropped pin" label).
 * Best-effort and non-blocking — never throws.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  try {
    const res = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
    if (!res.ok) return null;
    const data = (await res.json()) as ReverseGeocodeResult;
    log.debug("reverse", { lat, lng, name: data.name, address: data.address });
    return data;
  } catch (err) {
    log.warn("reverse failed", { error: String(err) });
    return null;
  }
}

/** The label to show for a reverse-geocoded pin: a POI name, else the address. */
export function pinLabel(r: ReverseGeocodeResult | null): string | null {
  return r?.name || r?.address || null;
}

/**
 * Reverse-geocode many points with BOUNDED concurrency (best-effort) — used to
 * name a batch of imported GPX waypoints without bursting the provider. Results
 * align by index; failures are null. Throttle = max in-flight requests.
 */
export async function reverseGeocodeBatch(
  points: { lat: number; lng: number }[],
  concurrency = 5,
): Promise<(ReverseGeocodeResult | null)[]> {
  const out: (ReverseGeocodeResult | null)[] = new Array(points.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < points.length) {
      const i = next++;
      out[i] = await reverseGeocode(points[i].lat, points[i].lng);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, points.length) }, worker));
  return out;
}
