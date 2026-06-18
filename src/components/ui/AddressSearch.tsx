"use client";

import { useEffect, useRef, useState } from "react";

import { createLogger } from "@/lib/logger";
import type { GeocodeResult } from "@/lib/types";

const log = createLogger("address-search");

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
  const justSelected = useRef(false);
  const firstRun = useRef(true);

  useEffect(() => {
    // Don't auto-search the value present at mount — when the field is pre-filled
    // (e.g. editing an existing waypoint), the location is already known, so a
    // geocode + results dropdown on open would be unsolicited. Search only once
    // the user actually edits the text.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    // Honour the Nominatim 1 req/sec limit with a 1s debounce.
    if (justSelected.current) {
      justSelected.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        const data = (await res.json()) as { results: GeocodeResult[] };
        setResults(data.results);
        setOpen(true);
        log.debug("results", { q: query, count: data.results.length });
      } catch (err) {
        log.error("search failed", { error: String(err) });
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 1000);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
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
        onFocus={() => results.length > 0 && setOpen(true)}
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
