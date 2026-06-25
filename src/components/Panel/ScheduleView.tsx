"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from "react";

import { initial } from "@/lib/colors";
import { distanceMeters } from "@/lib/geo";
import { pinLabel, reverseGeocode } from "@/lib/geocodeClient";
import { formatDistance, formatDuration, formatPaceShort } from "@/lib/units";
import { useFlockStore, useUnit } from "@/store/flockStore";

// Cache reverse-geocoded auto-endpoint names by ~10m cell so re-expanding a schedule (or two runners
// ending at the same spot) never re-hits the geocoder. Module-level so it survives remounts.
const placeCache = new Map<string, string | null>();
const shortPlace = (s: string) => s.split(",")[0].trim() || s;

/**
 * Per-participant plain-English schedule. Conversational throughout — "flocking
 * with [name]" for together stretches, "running solo" for the rest, never
 * "shared segment". Together stretches are tinted in the co-runner's colour.
 */
export default function ScheduleView({ participantId }: { participantId: string }) {
  const session = useFlockStore((s) => s.session);
  const calcError = useFlockStore((s) => s.calcError);
  const hoveredSegment = useFlockStore((s) => s.hoveredSegment);
  const setHoveredSegment = useFlockStore((s) => s.setHoveredSegment);
  const unit = useUnit();

  // Drop any segment emphasis when this schedule collapses, so the map doesn't keep a
  // stretch lit with no row under the pointer.
  useEffect(() => () => setHoveredSegment(null), [setHoveredSegment]);

  // The runner + their computed route + its arc endpoints (any may be absent until the first calc).
  const participant = session?.participants.find((p) => p.id === participantId);
  const route = session?.computedRoutes?.find((r) => r.participantId === participantId);
  const startPt = route?.waypoints?.[0];
  const finishPt = route?.waypoints?.[3];

  // Reverse-geocode an AUTO end the engine placed OFF any waypoint, lazily + cached, so "Home" becomes
  // the real place (where you peel off, a loop's base). Keyed on the pins + endpoints so it re-runs only
  // when those change — NOT on every poll (a fresh session object each time would thrash setState).
  const [geo, setGeo] = useState<{ start: string | null; finish: string | null }>({ start: null, finish: null });
  const geoKey = `${participantId}|${participant?.startPin.kind}|${participant?.finishPin.kind}|${startPt?.lat},${startPt?.lng}|${finishPt?.lat},${finishPt?.lng}`;
  useEffect(() => {
    if (!session || !participant || !startPt || !finishPt) return;
    const offWp = (pt: { lat: number; lng: number }) => !session.waypoints.some((w) => distanceMeters(w.location, pt) < 140);
    const jobs: Array<["start" | "finish", { lat: number; lng: number }]> = [];
    if (participant.startPin.kind === "auto" && offWp(startPt)) jobs.push(["start", startPt]);
    if (participant.finishPin.kind === "auto" && offWp(finishPt)) jobs.push(["finish", finishPt]);
    if (jobs.length === 0) return;
    let cancelled = false;
    void Promise.all(
      jobs.map(async ([which, pt]): Promise<["start" | "finish", string | null]> => {
        const key = `${pt.lat.toFixed(4)},${pt.lng.toFixed(4)}`;
        if (!placeCache.has(key)) placeCache.set(key, pinLabel(await reverseGeocode(pt.lat, pt.lng)));
        const label = placeCache.get(key) ?? null;
        return [which, label ? shortPlace(label) : null];
      }),
    ).then((res) => {
      if (!cancelled) setGeo((prev) => ({ ...prev, ...Object.fromEntries(res) }));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoKey]);

  if (!session || !participant) return null;

  const colorOf = (id: string) => session.participants.find((p) => p.id === id)?.color ?? "#fff";
  const nameOf = (id: string) => session.participants.find((p) => p.id === id)?.name ?? "someone";

  // The place name to show for a runner's start/finish, trimmed to its leading segment ("13 Hawthorn
  // Rd, Northcote" → "13 Hawthorn Rd"). A MANUAL pin's address or a WAYPOINT's name comes off the plan;
  // an AUTO end has no chosen place — name it the waypoint it landed on (you finish WITH the flock at its
  // destination), a loop home borrows the start's name, else the geo lookup above fills it in, else "home".
  const near = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => distanceMeters(a, b) < 140;
  const pinName = (pin: typeof participant.startPin): string | null => {
    if (pin.kind === "manual") return shortPlace(pin.address);
    if (pin.kind === "waypoint") {
      const w = session.waypoints.find((x) => x.id === pin.waypointId);
      return w ? shortPlace(w.name) : null;
    }
    return null;
  };
  const waypointAt = (pt?: { lat: number; lng: number }): string | null => {
    if (!pt) return null;
    const w = session.waypoints.find((x) => near(x.location, pt));
    return w ? shortPlace(w.name) : null;
  };
  // priority: a chosen pin → a waypoint it lands on → its reverse-geocoded place → (finish only) a loop
  // back to the start → the generic "home".
  const startName = pinName(participant.startPin) ?? waypointAt(startPt) ?? geo.start;
  const finishName =
    pinName(participant.finishPin) ??
    waypointAt(finishPt) ??
    geo.finish ??
    (startName && startPt && finishPt && near(startPt, finishPt) ? startName : null);

  if (!route) {
    // A named session-level error (e.g. no geography to route) is shown above the list — don't
    // also sit here on a perpetual "Working out…" spinner that never resolves.
    if (calcError) return null;
    return (
      <div className="mt-2 rounded-lg bg-surface px-3 py-2 text-xs text-text-dim">
        Working out this route…
      </div>
    );
  }

  // Narrative framing: which solo legs are the approach / the way home, whether
  // there's any company at all, how much of the run is shared, and whether the
  // flock accelerates. Pace usually only drops as slower runners peel off, but a
  // slower runner can also JOIN mid-route (entry is a free variable), so only
  // call it "quickening from peel-offs" when the together paces are monotonically
  // non-increasing AND net faster — otherwise the phrasing would mislead.
  const runIdxs = route.schedule.flatMap((s, i) => (s.type === "run" ? [i] : []));
  const firstRunIdx = runIdxs[0] ?? -1;
  const lastRunIdx = runIdxs[runIdxs.length - 1] ?? -1;
  const hasCompany = route.schedule.some((s) => s.companionIds.length > 0);
  const togetherKm = route.schedule
    .filter((s) => s.companionIds.length > 0)
    .reduce((sum, s) => sum + s.distanceKm, 0);
  const togetherPaces = route.schedule
    .filter((s) => s.companionIds.length > 0 && s.paceSecPerKm)
    .map((s) => s.paceSecPerKm as number);
  const monotonic = togetherPaces.every((p, i) => i === 0 || p <= togetherPaces[i - 1] + 1);
  const accelerates =
    togetherPaces.length >= 2 && monotonic && togetherPaces[0] > togetherPaces[togetherPaces.length - 1] + 1;

  const summary = hasCompany
    ? `${formatDistance(route.distanceKm, unit)} in ${formatDuration(route.estimatedDurationMinutes)} — ${formatDistance(togetherKm, unit)} of it with the flock.`
    : `${formatDistance(route.distanceKm, unit)} in ${formatDuration(route.estimatedDurationMinutes)}, solo today.`;

  const soloLabel = (i: number) => {
    if (!hasCompany) return "Running solo";
    if (i === firstRunIdx) return "Head out to meet the flock";
    if (i === lastRunIdx) return finishName ? `Head to ${finishName}` : "Head home";
    return "Your own stretch";
  };

  return (
    <div className="mt-2 space-y-1.5 rounded-lg bg-surface px-3 py-3">
      <p className="px-1 pb-1 text-xs leading-snug text-text-dim">{summary}</p>

      <Line
        time={route.departureTime}
        text={hasCompany ? `Set off from ${startName ?? "home"}` : `Leave ${startName ?? "home"}`}
        emphasis
      />

      {route.schedule.map((seg, i) => {
        // Hover / focus / tap a row to light up just that stretch of the runner's route on the
        // map. Pure set-and-clear (no toggle): pointer hover AND keyboard focus both preview it,
        // a tap sets it, and it clears when the pointer or focus leaves — so a click can never
        // cancel the hover it's sitting on. aria-pressed exposes the lit state to assistive tech.
        const active = hoveredSegment?.participantId === participantId && hoveredSegment.index === i;
        const show = () => setHoveredSegment({ participantId, index: i });
        const clear = () => setHoveredSegment(null);
        const stretch =
          seg.type === "rest"
            ? "the coffee stop"
            : seg.companionIds.length > 0
              ? `flocking with ${seg.companionIds.map(nameOf).join(" + ")}`
              : soloLabel(i).toLowerCase();
        const rowProps = {
          role: "button" as const,
          tabIndex: 0,
          "aria-pressed": active,
          "aria-label": `Highlight ${stretch} on the map`,
          onMouseEnter: show,
          onFocus: show,
          onMouseLeave: clear,
          onBlur: clear,
          onClick: show,
          onKeyDown: (e: ReactKeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              show();
            }
          },
        };
        const ring = active ? " ring-1 ring-inset ring-white/30" : "";

        if (seg.type === "rest") {
          return (
            <div key={i} {...rowProps} className={`cursor-pointer rounded-md bg-surface-lift/60 px-2 py-1.5${ring}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="mono text-xs text-fog">
                  {seg.startTime}–{seg.endTime}
                </span>
                <span className="text-xs text-text">Coffee stop ☕</span>
              </div>
            </div>
          );
        }

        const withSomeone = seg.companionIds.length > 0;
        const tint = withSomeone ? colorOf(seg.companionIds[0]) : undefined;
        const who = seg.companionIds.map(nameOf).join(" + ");

        return (
          <div
            key={i}
            {...rowProps}
            className={`cursor-pointer rounded-md px-2 py-1.5${ring}`}
            style={
              withSomeone
                ? { background: `${tint}22`, borderLeft: `2px solid ${tint}` }
                : undefined
            }
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="mono text-xs text-fog">
                {seg.startTime}–{seg.endTime}
              </span>
              <span className="mono text-xs text-text-dim">
                {formatDistance(seg.distanceKm, unit)}
                {seg.paceSecPerKm ? ` · ${formatPaceShort(seg.paceSecPerKm, unit)}` : ""}
              </span>
            </div>
            <div className="mt-0.5 text-xs">
              {withSomeone ? (
                <span className="text-text">
                  Flocking with <span style={{ color: tint }}>{who}</span>
                </span>
              ) : (
                <span className="text-text-dim">{soloLabel(i)}</span>
              )}
            </div>
          </div>
        );
      })}

      <Line
        time={route.arrivalTime}
        text={`${finishName ?? "Home"} · ${formatDistance(route.distanceKm, unit)} · ${formatDuration(
          route.estimatedDurationMinutes,
        )} moving`}
        emphasis
      />

      {accelerates && (
        <p className="px-1 pt-1 text-xs leading-snug text-together">
          The flock quickens as runners peel off home.
        </p>
      )}
    </div>
  );
}

function Line({ time, text, emphasis }: { time: string; text: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 px-1">
      <span className="mono text-xs text-together">{time}</span>
      <span className={`text-xs ${emphasis ? "text-text" : "text-text-dim"}`}>{text}</span>
    </div>
  );
}
