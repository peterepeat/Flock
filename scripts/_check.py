#!/usr/bin/env python3
"""Compact pass/fail checker for a calculated flock (reads flock JSON on stdin).

argv: <label> <expect_routes> <expect_together 0|1> <expect_stop 0|1>
Exits non-zero on any failed assertion. Prints one PASS/FAIL line.
"""
import sys, json

label = sys.argv[1]
expect_routes = int(sys.argv[2])
expect_together = int(sys.argv[3])
expect_stop = int(sys.argv[4])

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

totkm = round(sum(r["distanceKm"] for r in routes), 1)
status = "PASS" if not fails else "FAIL"
print(f"  {status}  {label}: {len(routes)} routes · {totkm}km total · {round(tot)}min together")
if fails:
    print("        ↳ " + "; ".join(fails))
sys.exit(1 if fails else 0)
