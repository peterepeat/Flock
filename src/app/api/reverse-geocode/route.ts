import { NextResponse } from "next/server";

import { createLogger } from "@/lib/logger";
import { photonReverse } from "@/lib/photon";
import type { ReverseGeocodeResult } from "@/lib/types";

const log = createLogger("api:reverse-geocode");

export const dynamic = "force-dynamic";

const USER_AGENT = "Flock/1.0 (peter@haasz.com.au)";

// A tapped point is auto-named after a nearby POI only if a NAMED point-of-interest
// sits within this many metres — otherwise the tap wasn't really "on" it and we
// fall back to the nearest street/place label.
const POI_RADIUS_M = 70;

interface NominatimReverse {
  display_name?: string;
  name?: string;
}

/** Fallback: Nominatim reverse, preferring a POI/address label. */
async function nominatimReverse(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("namedetails", "0");
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const r = (await res.json()) as NominatimReverse;
  const address = r.display_name ? r.display_name.split(",").slice(0, 2).join(",").trim() : null;
  return { name: r.name || null, address };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get("lat") || "");
  const lng = parseFloat(searchParams.get("lng") || "");
  const done = log.time("reverse-geocode", { lat, lng });

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    done({ error: "bad-coords" });
    return NextResponse.json({ error: "bad-coords" }, { status: 400 });
  }

  // Primary: Photon reverse. The nearest NAMED POI within POI_RADIUS_M names the
  // pin; otherwise the nearest place's label is the address. An EMPTY result (a
  // data-sparse spot) falls through to Nominatim rather than returning nothing.
  try {
    const places = await photonReverse({ lat, lng });
    if (places.length > 0) {
      const poi = places.find((p) => p.isPoi && p.name && p.distanceM <= POI_RADIUS_M);
      const result: ReverseGeocodeResult = {
        name: poi?.name ?? null,
        address: places[0].shortName,
      };
      done({ provider: "photon", name: result.name, hasAddress: !!result.address });
      return NextResponse.json(result);
    }
    log.debug("photon reverse empty — trying nominatim");
  } catch (err) {
    log.warn("photon reverse failed — falling back to nominatim", { error: String(err) });
  }

  try {
    const result = (await nominatimReverse(lat, lng)) ?? { name: null, address: null };
    done({ provider: "nominatim", name: result.name });
    return NextResponse.json(result);
  } catch (err) {
    log.error("reverse-geocode failed (both providers)", { error: String(err) });
    done({ error: true });
    // Soft failure: the pin just keeps its "Dropped pin" label.
    return NextResponse.json({ name: null, address: null } satisfies ReverseGeocodeResult);
  }
}
