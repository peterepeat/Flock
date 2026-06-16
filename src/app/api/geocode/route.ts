import { NextResponse } from "next/server";

import { createLogger } from "@/lib/logger";
import type { GeocodeResult } from "@/lib/types";

const log = createLogger("api:geocode");

export const dynamic = "force-dynamic";

// Nominatim requires a descriptive User-Agent (their usage policy) and allows at
// most ~1 req/sec. The client debounces by 1s; this proxy adds the User-Agent
// that a browser fetch cannot set itself.
const USER_AGENT = "Flock/1.0 (peter@haasz.com.au)";

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  addresstype?: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  const done = log.time("geocode", { q });

  if (q.length < 3) {
    done({ skipped: true });
    return NextResponse.json({ results: [] });
  }

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "0");
    url.searchParams.set("limit", "6");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    });

    if (!res.ok) {
      log.warn("nominatim error", { status: res.status });
      done({ error: res.status });
      return NextResponse.json({ results: [], error: "search-unavailable" }, { status: 502 });
    }

    const raw = (await res.json()) as NominatimResult[];
    const results: GeocodeResult[] = raw.map((r) => ({
      displayName: r.display_name,
      shortName: r.display_name.split(",").slice(0, 2).join(",").trim(),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    }));

    done({ count: results.length });
    return NextResponse.json({ results });
  } catch (err) {
    log.error("geocode failed", { q, error: String(err) });
    done({ error: true });
    return NextResponse.json({ results: [], error: "search-failed" }, { status: 500 });
  }
}
