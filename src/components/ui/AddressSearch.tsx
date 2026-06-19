"use client";

import { useEffect, useRef, useState } from "react";

import { createLogger } from "@/lib/logger";
import type { GeocodeResult, LatLng } from "@/lib/types";
import { useFlockStore } from "@/store/flockStore";

const log = createLogger("address-search");

// Photon (the primary backend) permits type-ahead, so we debounce far tighter
// than the 1s the old Nominatim-only path was forced into.
const DEBOUNCE_MS = 250;
const MIN_CHARS = 3;
const CACHE_MAX = 50;

interface AddressSearchProps {
  initialValue?: string;
  placeholder?: string;
  onSelect: (result: GeocodeResult) => void;
}

export default function AddressSearch({
  initialValue = "",
  placeholder = "Search for an address or place",
  onSelect,
}: AddressSearchProps) {
  const [query, setQuery] = useState(initialValue);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Map<string, GeocodeResult[]>>(new Map());
  const justSelected = useRef(false);
  const firstRun = useRef(true);
  const focused = useRef(false);

  // The live map view biases results toward what the user is looking at. Held in a
  // ref so panning doesn't re-arm the debounce; read at fetch time.
  const mapCenter = useFlockStore((s) => s.mapCenter);
  const mapBounds = useFlockStore((s) => s.mapBounds);
  const viewRef = useRef({ mapCenter, mapBounds });
  viewRef.current = { mapCenter, mapBounds };

  // Cache key bundles the query with the bias centre, so a result fetched for one
  // map view isn't served as if it were biased to another.
  const keyFor = (q: string, c: LatLng | null) =>
    `${q.toLowerCase()}|${c ? `${c.lat.toFixed(2)},${c.lng.toFixed(2)}` : ""}`;

  // Sync the box to an EXTERNAL change of initialValue (e.g. a dropped pin a
  // reverse-geocode just named) — but only into an EMPTY, unfocused field, so we
  // never overwrite text the user has typed or a result they just picked.
  useEffect(() => {
    if (focused.current || query.length > 0) return;
    if (initialValue === query) return;
    justSelected.current = true; // a synced value must not trigger a search
    setQuery(initialValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue]);

  useEffect(() => {
    // Don't auto-search the value present at mount (pre-filled = already known).
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    // A pick from the dropdown / an external sync sets the box text; don't search it.
    if (justSelected.current) {
      justSelected.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setOpen(false);
      return;
    }

    // Instant path: a cached result for this exact query+view (e.g. after a backspace).
    const cached = cacheRef.current.get(keyFor(q, viewRef.current.mapCenter));
    if (cached) {
      setResults(cached);
      setOpen(true);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      // Cancel any in-flight request so a slow earlier response can't clobber this one.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // Snapshot the view ONCE so the bias we fetch with and the key we store under
      // are the same, even if the user pans mid-flight.
      const view = viewRef.current;
      const key = keyFor(q, view.mapCenter);
      setLoading(true);
      try {
        const params = new URLSearchParams({ q });
        if (view.mapCenter) {
          params.set("lat", String(view.mapCenter.lat));
          params.set("lng", String(view.mapCenter.lng));
        }
        if (view.mapBounds) {
          const b = view.mapBounds;
          params.set("viewbox", `${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`);
        }
        const res = await fetch(`/api/geocode?${params.toString()}`, { signal: ctrl.signal });
        const data = (await res.json()) as { results: GeocodeResult[] };
        if (cacheRef.current.size >= CACHE_MAX) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest !== undefined) cacheRef.current.delete(oldest);
        }
        cacheRef.current.set(key, data.results);
        setResults(data.results);
        setOpen(true);
        log.debug("results", { q, count: data.results.length });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // superseded by a newer keystroke
        log.error("search failed", { error: String(err) });
        setResults([]);
      } finally {
        if (abortRef.current === ctrl) setLoading(false); // only the latest clears the spinner
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort(); // drop an in-flight request on unmount / next keystroke
    };
  }, [query]);

  function choose(r: GeocodeResult) {
    justSelected.current = true;
    setQuery(r.shortName);
    setResults([]);
    setOpen(false);
    onSelect(r);
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          focused.current = true;
          if (results.length > 0) setOpen(true);
        }}
        onBlur={() => {
          focused.current = false;
        }}
        className="w-full rounded-lg border border-white/10 bg-surface-lift px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-accent/60"
      />
      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fog">
          …
        </span>
      )}
      {open && results.length > 0 && (
        <ul className="absolute z-[1100] mt-1 max-h-56 w-full overflow-auto rounded-lg border border-white/10 bg-surface-mid shadow-panel flock-scroll">
          {results.map((r, i) => (
            <li key={`${r.lat}-${r.lng}-${i}`}>
              <button
                type="button"
                onClick={() => choose(r)}
                className="block w-full px-3 py-2 text-left text-sm text-text hover:bg-surface-lift"
              >
                <span className="block truncate">{r.shortName}</span>
                <span className="block truncate text-xs text-fog">{r.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
