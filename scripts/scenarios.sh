#!/usr/bin/env bash
# Flock — reproducible verification scenarios for the Together-Minutes engine.
#
# Seeds the canonical test flocks via the API and prints the calculated result
# (per-runner distance + schedule + shared legs) so the engine can be re-verified
# in one command after any change. Mirrors the scenarios in the design plan
# (~/.claude/plans/i-ve-been-ruminating-*.md).
#
# Usage:   ./scripts/scenarios.sh [PORT] [a|b|d|all]
#   PORT defaults to 3000.  Scenario defaults to "all".
#
# Scenarios:
#   a — Peter 18km + Collin unconstrained  → Collin runs ~his whole run with Peter.
#   b — a + Dana capped 8km                → nested peel-off; Dana joins near home.
#   d — Capital City Trail loop            → 2 anchors do the whole loop; joiners
#                                            (Richmond/Parkville/Docklands) join the
#                                            loop NEAR HOME, not the origin.
set -euo pipefail
PORT="${1:-3000}"
WHICH="${2:-all}"
BASE="http://localhost:${PORT}"

create() { curl -s -X POST "$BASE/api/flocks/create" -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"; }
patch()  { curl -s -X PATCH "$BASE/api/flocks/$1" -H 'Content-Type: application/json' -d "$2" -o /dev/null -w "  $3 %{http_code}\n"; }
calc()   { curl -s -X POST "$BASE/api/routes/calculate" -H 'Content-Type: application/json' -d "{\"flockId\":\"$1\"}" -o /dev/null -w "  calc %{http_code}\n"; }
show()   {
  curl -s "$BASE/api/flocks/$1" | python3 -c "
import sys,json
s=json.load(sys.stdin); names={p['id']:p['name'] for p in s['participants']}; cap={p['id']:p.get('maxDistance') for p in s['participants']}
for r in s['computedRoutes'] or []:
    c=cap[r['participantId']]; flag=' OVER CAP!' if c and r['distanceKm']>c+0.6 else ''
    print(f\"  {names[r['participantId']]:7} {r['distanceKm']}km (cap {c}){flag}  {r['departureTime']}-{r['arrivalTime']}\")
    for seg in r['schedule']:
        comp=' + '.join(names.get(c2,c2) for c2 in seg['companionIds']) if seg['companionIds'] else 'solo'
        tag='REST '+(seg.get('label') or '') if seg['type']=='rest' else f\"{seg['distanceKm']}km [{comp}]\"
        print(f\"       {seg['startTime']}-{seg['endTime']} {tag}\")
print('  shared legs:', *[ '%s(%.0fm)'%('+'.join(names[i] for i in ss['participantIds']), ss['overlapMinutes']) for ss in (s['sharedSegments'] or []) ])
"
}

scenario_ab() {
  local F; F=$(create); echo "Scenario a/b → $BASE/flock/$F"
  patch "$F" '{"action":"addParticipant","editToken":"t1","participant":{"name":"Peter","startLocation":{"lat":-37.7700,"lng":144.9990},"startAddress":"Northcote","earliestStartTime":"07:00","preferredPace":360,"maxPace":300,"preferredDistance":18,"maxDistance":20,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Peter
  patch "$F" '{"action":"addParticipant","editToken":"t2","participant":{"name":"Collin","startLocation":{"lat":-37.8110,"lng":144.9690},"startAddress":"Melbourne","earliestStartTime":"07:00","preferredPace":360,"maxPace":300,"preferredDistance":null,"maxDistance":null,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Collin
  echo "[a]"; calc "$F"; show "$F"
  patch "$F" '{"action":"addParticipant","editToken":"t3","participant":{"name":"Dana","startLocation":{"lat":-37.7980,"lng":144.9780},"startAddress":"Fitzroy North","earliestStartTime":"07:00","preferredPace":420,"maxPace":360,"preferredDistance":8,"maxDistance":8,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Dana
  echo "[b]"; calc "$F"; show "$F"
}

scenario_d() {
  local F; F=$(create); echo "Scenario d (Capital City Trail) → $BASE/flock/$F"
  wp() { patch "$F" "{\"action\":\"addWaypoint\",\"waypoint\":{\"location\":{\"lat\":$1,\"lng\":$2},\"address\":\"$3\",\"name\":\"$3\",\"stopMinutes\":0}}" "wp:$3"; }
  wp -37.7980 144.9780 Fitzroy;   wp -37.7850 144.9520 Parkville; wp -37.8080 144.9450 NthMelb
  wp -37.8190 144.9460 Docklands; wp -37.8230 144.9680 CBD;       wp -37.8250 144.9950 Richmond
  wp -37.8230 145.0100 Burnley;   wp -37.8000 145.0050 Abbotsford;wp -37.7890 144.9950 CliftonHill
  wp -37.7980 144.9785 FitzroyClose
  patch "$F" '{"action":"addParticipant","editToken":"a1","participant":{"name":"Anya","startLocation":{"lat":-37.7980,"lng":144.9780},"startAddress":"Fitzroy","earliestStartTime":"07:00","preferredPace":330,"maxPace":300,"preferredDistance":null,"maxDistance":null,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Anya
  patch "$F" '{"action":"addParticipant","editToken":"a2","participant":{"name":"Arlo","startLocation":{"lat":-37.7975,"lng":144.9790},"startAddress":"Fitzroy","earliestStartTime":"07:00","preferredPace":345,"maxPace":300,"preferredDistance":30,"maxDistance":32,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Arlo
  patch "$F" '{"action":"addParticipant","editToken":"j1","participant":{"name":"Remy","startLocation":{"lat":-37.8240,"lng":145.0000},"startAddress":"Richmond","earliestStartTime":"07:00","preferredPace":390,"maxPace":340,"preferredDistance":10,"maxDistance":11,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Remy
  patch "$F" '{"action":"addParticipant","editToken":"j2","participant":{"name":"Pia","startLocation":{"lat":-37.7830,"lng":144.9550},"startAddress":"Parkville","earliestStartTime":"07:00","preferredPace":420,"maxPace":360,"preferredDistance":8,"maxDistance":8,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Pia
  patch "$F" '{"action":"addParticipant","editToken":"j3","participant":{"name":"Dev","startLocation":{"lat":-37.8170,"lng":144.9480},"startAddress":"Docklands","earliestStartTime":"07:00","preferredPace":400,"maxPace":350,"preferredDistance":13,"maxDistance":14,"finishLocation":null,"finishAddress":null,"latestFinishTime":null,"restStop":null}}' Dev
  echo "[d]"; calc "$F"; show "$F"
}

case "$WHICH" in
  a|b) scenario_ab ;;
  d)   scenario_d ;;
  all) scenario_ab; echo; scenario_d ;;
  *)   echo "unknown scenario: $WHICH (use a|b|d|all)"; exit 1 ;;
esac
