#!/usr/bin/env bash
# Flock — verification scenario suite for the Together-Minutes engine.
#
# Seeds canonical flocks via the API, calculates routes, and asserts pass/fail
# (scripts/_check.py). The one-command regression test after any engine change,
# and the anti-regression artifact for picking up across sessions.
#
# Usage:   ./scripts/scenarios.sh [PORT] [SCENARIO] [SLEEP]
#   PORT     defaults to 3000.
#   SCENARIO one of: s1 s2 s3 s4 s5 s6 pc ext cct all   (default: all)
#   SLEEP    seconds between scenarios in "all" (default 20) — the free ORS tier
#            allows ~40 reqs/min, and a 5-person scenario bursts ~11, so "all"
#            must be paced or later scenarios get rate-limited (0 routes). With 9
#            scenarios now, 20s keeps the sliding-window rate comfortably under.
#
# Coverage matrix ({1 person, 5 people} × {no / 1 / 3+ waypoints incl. a stop}):
#   s1  1 person,  no waypoints
#   s2  1 person,  one waypoint
#   s3  1 person,  3 waypoints incl. a stop
#   s4  5 people (disparate),  no waypoints     — also covers latest-finish + a far runner
#   s5  5 people (disparate),  one waypoint
#   s6  5 people (disparate),  3 waypoints incl. a stop
# Augmented:
#   pc  2 people: Peter (18km) + Collin (unconstrained)  — headline "together" regression
#   ext 3 clustered constrained runners — keenest solos a tail past the backbone
#   cct Capital City Trail loop: 2 anchors + 3 drop-in joiners around the loop
set -uo pipefail
PORT="${1:-3000}"
WHICH="${2:-all}"
SLEEP="${3:-20}"
BASE="http://localhost:${PORT}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0

create() { curl -s -X POST "$BASE/api/flocks/create" -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"; }
patch()  { curl -s -X PATCH "$BASE/api/flocks/$1" -H 'Content-Type: application/json' -d "$2" -o /dev/null; }
calc()   { curl -s -X POST "$BASE/api/routes/calculate" -H 'Content-Type: application/json' -d "{\"flockId\":\"$1\"}" -o /dev/null; }
# person NAME LAT LNG [extraJSON]
person() { patch "$1" "{\"action\":\"addParticipant\",\"editToken\":\"$2\",\"participant\":{\"name\":\"$2\",\"startLocation\":{\"lat\":$3,\"lng\":$4},\"startAddress\":\"$2\",\"earliestStartTime\":\"07:00\",\"finishLocation\":null,\"finishAddress\":null,\"latestFinishTime\":${6:-null},\"preferredPace\":${7:-360},\"maxPace\":${8:-300},\"preferredDistance\":${5:-null},\"maxDistance\":${9:-null},\"restStop\":null}}" "$2"; }
wp()     { patch "$1" "{\"action\":\"addWaypoint\",\"waypoint\":{\"location\":{\"lat\":$2,\"lng\":$3},\"address\":\"$4\",\"name\":\"$4\",\"stopMinutes\":${5:-0}}}"; }
# check FID LABEL EXPECT_ROUTES EXPECT_TOGETHER EXPECT_STOP
check()  { calc "$1"; if curl -s "$BASE/api/flocks/$1" | python3 "$DIR/_check.py" "$2" "$3" "$4" "$5"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; }

# 5 disparate people (shared across s4/s5/s6). args: FID
add5() {
  local F="$1"
  # name token lat lng pref-dist latest pace maxpace maxdist
  person "$F" Mara  -37.7700 144.9990 22   null    330 300 24    # long, fast, Northcote
  person "$F" Cole  -37.8140 144.9630 null null    300 300 null  # unconstrained anchor, CBD
  person "$F" Nia   -37.8240 145.0000 10   '"08:15"' 390 340 11  # short + tight deadline, Richmond
  person "$F" Tom   -37.7670 144.9600 14   null    360 320 15    # mid, Brunswick
  person "$F" Pippa -37.8060 145.0300 7    null    420 360 7     # short + far (Kew)
}

s1() { local F; F=$(create); echo "s1 → $BASE/flock/$F"; person "$F" Solo -37.8000 144.9670 8 null 360 300 9; check "$F" "s1 1p/no-wp" 1 0 0; }
s2() { local F; F=$(create); echo "s2 → $BASE/flock/$F"; person "$F" Solo -37.8000 144.9670 8 null 360 300 9; wp "$F" -37.7840 144.9610 PrincesPark; check "$F" "s2 1p/1-wp" 1 0 0; }
s3() { local F; F=$(create); echo "s3 → $BASE/flock/$F"; person "$F" Solo -37.8000 144.9670 10 null 360 300 12; wp "$F" -37.7840 144.9610 PrincesPark; wp "$F" -37.8050 144.9720 CarltonCafe 15; wp "$F" -37.7980 144.9780 Fitzroy; check "$F" "s3 1p/3-wp+stop" 1 0 1; }
s4() { local F; F=$(create); echo "s4 → $BASE/flock/$F"; add5 "$F"; check "$F" "s4 5p/no-wp" 5 1 0; }
s5() { local F; F=$(create); echo "s5 → $BASE/flock/$F"; add5 "$F"; wp "$F" -37.8050 144.9720 CarltonGardens; check "$F" "s5 5p/1-wp" 5 1 0; }
s6() { local F; F=$(create); echo "s6 → $BASE/flock/$F"; add5 "$F"; wp "$F" -37.7840 144.9610 PrincesPark; wp "$F" -37.8050 144.9720 CarltonCafe 15; wp "$F" -37.8000 145.0050 Abbotsford; check "$F" "s6 5p/3-wp+stop" 5 1 1; }

pc() { local F; F=$(create); echo "pc → $BASE/flock/$F"; person "$F" Peter -37.7700 144.9990 18 null 360 300 20; person "$F" Collin -37.8110 144.9690 null null 360 300 null; check "$F" "pc 2p Peter+Collin" 2 1 0; }

# Solo-extension: 3 clustered constrained runners, no unconstrained anchor and a
# clear single longest. Backbone is sized to the 2nd-longest (Dana ~20km), so the
# keenest (Peter, 30km) runs the whole backbone with the flock then solos the tail
# to hit target. Asserts (expect_target=1) Peter reaches ~30km, not ~20km.
ext() {
  local F; F=$(create); echo "ext → $BASE/flock/$F"
  person "$F" Peter -37.7980 144.9780 30 null 360 300 33   # keenest — solos the tail
  person "$F" Dana  -37.8000 144.9700 20 null 360 300 22   # 2nd-longest sets backbone reach
  person "$F" Eve   -37.7950 144.9750 16 null 360 300 18   # peels off earliest
  check "$F" "ext solo-extension" 3 1 0 1
}

cct() {
  local F; F=$(create); echo "cct → $BASE/flock/$F"
  wp "$F" -37.7980 144.9780 Fitzroy;   wp "$F" -37.7850 144.9520 Parkville; wp "$F" -37.8080 144.9450 NthMelb
  wp "$F" -37.8190 144.9460 Docklands; wp "$F" -37.8230 144.9680 CBD;       wp "$F" -37.8250 144.9950 Richmond
  wp "$F" -37.8230 145.0100 Burnley;   wp "$F" -37.8000 145.0050 Abbotsford;wp "$F" -37.7890 144.9950 CliftonHill
  wp "$F" -37.7980 144.9785 FitzroyClose
  person "$F" Anya -37.7980 144.9780 null null 330 300 null
  person "$F" Arlo -37.7975 144.9790 30   null 345 300 32
  person "$F" Remy -37.8240 145.0000 10   null 390 340 11
  person "$F" Pia  -37.7830 144.9550 8    null 420 360 8
  person "$F" Dev  -37.8170 144.9480 13   null 400 350 14
  check "$F" "cct Capital City Trail" 5 1 0
}

curl -s "$BASE/api/flocks/__ping__" -o /dev/null || { echo "server not reachable at $BASE"; exit 2; }
echo "Flock scenarios @ $BASE"
case "$WHICH" in
  all) for sc in s1 s2 s3 s4 s5 s6 pc ext cct; do "$sc"; [ "$sc" = cct ] || sleep "$SLEEP"; done ;;
  *)   "$WHICH" ;;
esac
echo "── $PASS passed, $FAIL failed ──"
exit $(( FAIL > 0 ? 1 : 0 ))
