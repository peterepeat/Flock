#!/usr/bin/env python3
"""Compact pass/fail checker for a calculated flock (reads flock JSON on stdin).

argv: <label> <expect_routes> <expect_together 0|1> <expect_stop 0|1> [expect_target 0|1] [expect_second_target 0|1]
Exits non-zero on any failed assertion. Prints one PASS/FAIL line.

expect_target=1 asserts the longest-targeted runner reaches near their
preferredDistance (within 2km) — the solo-extension guard: without it the keenest
runner is cut short where the (capped) backbone turns around.

expect_second_target=1 asserts the SECOND-longest-targeted runner also reaches
near their preferredDistance — the grown-spine guard: with a short waypoint
corridor and two keen runners the shared backbone must grow so the second runner
reaches target WITH the flock, not fall short on a capped corridor.
"""
import sys, json

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

s = json.load(sys.stdin)
parts = {p["id"]: p for p in s["participants"]}
names = {p["id"]: p["name"] for p in s["participants"]}
routes = s.get("computedRoutes") or []
shared = s.get("sharedSegments") or []
fails = []

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

totkm = round(sum(r["distanceKm"] for r in routes), 1)
status = "PASS" if not fails else "FAIL"
print(f"  {status}  {label}: {len(routes)} routes · {totkm}km total · {round(tot)}min together")
if fails:
    print("        ↳ " + "; ".join(fails))
sys.exit(1 if fails else 0)
