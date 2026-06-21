#!/usr/bin/env python3
"""Compact pass/fail checker for a calculated flock (reads flock JSON on stdin).

argv: <label> <expect_routes> <expect_together 0|1> <expect_stop 0|1> [expect_target 0|1] [expect_second_target 0|1] [expect_formation 0|1] [expect_dispersal 0|1] [expect_min_share] [expect_max_alone_km]
Exits non-zero on any failed assertion. Prints one PASS/FAIL line.

expect_min_share is the FAIRNESS floor: a budget-constrained runner shouldn't spend
most of their run alone (the gap that let "Jimmy" slip — every other check passed
while he ran ~half solo). Two forms: "NAME:FLOOR" pins a named runner (e.g.
"Jimmy:0.85" — FP-safe, used for every regression guard); a bare "FLOOR" derives the
target as the runner with the largest commute/cap ratio among finite-cap runners (the
budget-binding one). The fraction is shared-TIME over RUN-ONLY time (stop dwell
excluded — it isn't "alone" time and would otherwise depress stop-bearing fixtures).
Only evaluated when expect_together==1, so deliberate no-merge cases never trip it.
expect_max_alone_km bounds the flock's SUM of solo distance (geography-agnostic backstop).

expect_target=1 asserts the longest-targeted runner reaches near their
preferredDistance (within 2km) — the solo-extension guard: without it the keenest
runner is cut short where the (capped) backbone turns around.

expect_second_target=1 asserts the SECOND-longest-targeted runner also reaches
near their preferredDistance — the grown-spine guard: with a short waypoint
corridor and two keen runners the shared backbone must grow so the second runner
reaches target WITH the flock, not fall short on a capped corridor.
"""
import sys, json, math

label = sys.argv[1]
expect_routes = int(sys.argv[2])
expect_together = int(sys.argv[3])
expect_stop = int(sys.argv[4])
expect_target = int(sys.argv[5]) if len(sys.argv) > 5 else 0
expect_second_target = int(sys.argv[6]) if len(sys.argv) > 6 else 0
# expect_formation=1 asserts the computed formation point F fired: the shared spine
# starts measurably BEFORE the first waypoint (the flock gathers up the shared
# corridor, not pinned at wp0). The convergent-pair guard for Stage 0.
expect_formation = int(sys.argv[7]) if len(sys.argv) > 7 else 0
# expect_dispersal=1 is the egress mirror: the shared spine ENDS measurably PAST the
# last waypoint (the flock runs home together to a split point D/P, not pinned at the
# end). The convergent-pair guard for the dispersal side (natural D or forced D).
expect_dispersal = int(sys.argv[8]) if len(sys.argv) > 8 else 0
# Fairness floor (see docstring). "" / "0" / absent = off.
expect_min_share = sys.argv[9] if len(sys.argv) > 9 and sys.argv[9] not in ("", "0") else None
expect_max_alone_km = float(sys.argv[10]) if len(sys.argv) > 10 and sys.argv[10] not in ("", "0") else None

s = json.load(sys.stdin)
parts = {p["id"]: p for p in s["participants"]}
names = {p["id"]: p["name"] for p in s["participants"]}
routes = s.get("computedRoutes") or []
shared = s.get("sharedSegments") or []
fails = []


def _hav(la1, lo1, la2, lo2):
    dlat = math.radians(la2 - la1)
    dlng = math.radians(lo2 - lo1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(la1)) * math.cos(math.radians(la2)) * math.sin(dlng / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(a))


def run_min(r):
    # RUN-ONLY minutes (excludes rest dwell, which isn't "alone" time): Σ distanceKm·pace/60.
    return sum(seg["distanceKm"] * seg["paceSecPerKm"] / 60.0
               for seg in r["schedule"] if seg["type"] == "run" and seg.get("paceSecPerKm"))


def shared_frac(pid):
    """(shared-time fraction over run-only time, solo km). None,None if no route."""
    r = next((x for x in routes if x["participantId"] == pid), None)
    if not r:
        return None, None
    rm = run_min(r)
    sm = sum(seg["overlapMinutes"] for seg in shared if pid in seg.get("participantIds", []))
    if rm <= 0:
        return (1.0, 0.0) if sm == 0 else (None, None)
    frac = min(sm / rm, 1.0)
    return frac, round(r["distanceKm"] * (1 - frac), 2)

if len(routes) < expect_routes:
    fails.append(f"only {len(routes)}/{expect_routes} routes")

for r in routes:
    p = parts[r["participantId"]]
    nm = names[r["participantId"]]
    if r["distanceKm"] < 0.5:
        fails.append(f"{nm} degenerate route {r['distanceKm']}km")
    cap = p.get("maxDistance")
    if cap and r["distanceKm"] > cap + 0.6:
        fails.append(f"{nm} {r['distanceKm']}km > cap {cap}")
    lf = p.get("latestFinishTime")
    if lf and r["arrivalTime"] > lf:
        fails.append(f"{nm} finishes {r['arrivalTime']} > latest {lf}")
    # schedule sanity: times must be ordered and segments contiguous-ish
    for seg in r["schedule"]:
        if seg["startTime"] > seg["endTime"]:
            fails.append(f"{nm} segment time reversed")
            break

tot = sum(x["overlapMinutes"] for x in shared)
if expect_together and tot <= 0:
    fails.append("expected together-time, got 0")
if not expect_together and len(routes) <= 1 and shared:
    fails.append("solo run has shared segments")
has_stop = any(seg["type"] == "rest" for r in routes for seg in r["schedule"])
if expect_stop and not has_stop:
    fails.append("expected a stop, none found")

if expect_target:
    targeted = [p for p in s["participants"] if p.get("preferredDistance")]
    if not targeted:
        fails.append("expect_target but no runner has a preferredDistance")
    else:
        keenest = max(targeted, key=lambda p: p["preferredDistance"])
        dist = next((r["distanceKm"] for r in routes if r["participantId"] == keenest["id"]), 0)
        want = keenest["preferredDistance"]
        if dist < want - 2.0:
            fails.append(f"{names[keenest['id']]} reached {dist}km, short of target {want}km (extension failed)")

if expect_second_target:
    targeted = sorted(
        (p for p in s["participants"] if p.get("preferredDistance")),
        key=lambda p: p["preferredDistance"],
        reverse=True,
    )
    if len(targeted) < 2:
        fails.append("expect_second_target but fewer than 2 targeted runners")
    else:
        second = targeted[1]
        dist = next((r["distanceKm"] for r in routes if r["participantId"] == second["id"]), 0)
        want = second["preferredDistance"]
        if dist < want - 2.0:
            fails.append(f"{names[second['id']]} (2nd-longest) reached {dist}km, short of {want}km (spine not grown)")

if expect_formation:
    fr = s.get("flockRoute")
    wps = s.get("waypoints") or []
    if not fr or not fr.get("coordinates") or not wps:
        fails.append("expect_formation but no flockRoute/waypoints")
    else:
        import math
        lng0, lat0 = fr["coordinates"][0][0], fr["coordinates"][0][1]  # spine start [lng,lat]
        wp0 = wps[0]["location"]
        dlat = math.radians(wp0["lat"] - lat0)
        dlng = math.radians(wp0["lng"] - lng0)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(math.radians(lat0)) * math.cos(math.radians(wp0["lat"])) * math.sin(dlng / 2) ** 2)
        gap_km = 2 * 6371 * math.asin(math.sqrt(a))
        if gap_km < 0.5:
            fails.append(f"formation point did not fire (spine starts {round(gap_km*1000)}m from wp0, expected ≥500m before it)")

if expect_dispersal:
    fr = s.get("flockRoute")
    wps = s.get("waypoints") or []
    if not fr or not fr.get("coordinates") or not wps:
        fails.append("expect_dispersal but no flockRoute/waypoints")
    else:
        import math
        lngE, latE = fr["coordinates"][-1][0], fr["coordinates"][-1][1]  # spine END [lng,lat]
        wpL = wps[-1]["location"]  # last waypoint (== wp0 for a single-waypoint loop)
        dlat = math.radians(wpL["lat"] - latE)
        dlng = math.radians(wpL["lng"] - lngE)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(math.radians(latE)) * math.cos(math.radians(wpL["lat"])) * math.sin(dlng / 2) ** 2)
        gap_km = 2 * 6371 * math.asin(math.sqrt(a))
        if gap_km < 0.5:
            fails.append(f"dispersal point did not fire (spine ends {round(gap_km*1000)}m from last wp, expected ≥500m past it)")

# FAIRNESS: a budget-constrained runner shouldn't run mostly alone. Gated on
# expect_together so no-merge cases never trip it. NAME:FLOOR pins a runner;
# a bare FLOOR derives the most budget-binding one (largest commute/cap ratio).
if expect_min_share and expect_together:
    if ":" in expect_min_share:
        nm, floor = expect_min_share.split(":")
        floor = float(floor)
        tgt = next((p for p in s["participants"] if p["name"] == nm), None)
        if not tgt:
            fails.append(f"min-share names '{nm}' but no such runner")
    else:
        floor = float(expect_min_share)
        finite = [p for p in s["participants"] if p.get("maxDistance")]

        def commute_ratio(p):
            wps = s.get("waypoints") or []
            if wps:
                w = wps[0]["location"]
                commute = 2 * _hav(p["startLocation"]["lat"], p["startLocation"]["lng"], w["lat"], w["lng"])
            else:
                hs = [q["startLocation"] for q in s["participants"]]
                cy = sum(h["lat"] for h in hs) / len(hs)
                cx = sum(h["lng"] for h in hs) / len(hs)
                commute = 2 * _hav(p["startLocation"]["lat"], p["startLocation"]["lng"], cy, cx)
            return commute / p["maxDistance"]

        tgt = max(finite, key=commute_ratio, default=None)
    if tgt:
        frac, solo_km = shared_frac(tgt["id"])
        if frac is None:
            fails.append(f"{tgt['name']} has no usable route")
        elif frac < floor - 0.02:
            fails.append(f"{tgt['name']} only {round(frac*100)}% shared (~{solo_km}km solo) < floor {round(floor*100)}% — FAIRNESS")

if expect_max_alone_km is not None:
    tot_alone = round(sum((shared_frac(r["participantId"])[1] or 0) for r in routes), 1)
    if tot_alone > expect_max_alone_km:
        fails.append(f"flock alone-distance {tot_alone}km > bound {expect_max_alone_km}km")

totkm = round(sum(r["distanceKm"] for r in routes), 1)
worst = min((shared_frac(r["participantId"])[0] for r in routes if shared_frac(r["participantId"])[0] is not None), default=None)
share_note = f" · min-share {round(worst*100)}%" if worst is not None else ""
status = "PASS" if not fails else "FAIL"
print(f"  {status}  {label}: {len(routes)} routes · {totkm}km total · {round(tot)}min together{share_note}")
if fails:
    print("        ↳ " + "; ".join(fails))
sys.exit(1 if fails else 0)
