#!/usr/bin/env bash
# Flock — verification scenario suite for the Together-Minutes engine.
#
# Seeds canonical flocks via the API, calculates routes, and asserts pass/fail
# (scripts/_check.py). The one-command regression test after any engine change,
# and the anti-regression artifact for picking up across sessions.
#
# Usage:   ./scripts/scenarios.sh [PORT] [SCENARIO] [SLEEP]
#   PORT     defaults to 3000.
#   SCENARIO one of: s1 s2 s3 s4 s5 s6 pc ext cvg sw fwd fwd0 cct all   (default: all)
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
# check FID LABEL EXPECT_ROUTES EXPECT_TOGETHER EXPECT_STOP [EXPECT_TARGET] [EXPECT_SECOND_TARGET] [EXPECT_FORMATION]
check()  { calc "$1"; if curl -s "$BASE/api/flocks/$1" | python3 "$DIR/_check.py" "$2" "$3" "$4" "$5" "${6:-0}" "${7:-0}" "${8:-0}"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; }

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

# Grown spine: a SHORT waypoint corridor (two waypoints ~2km apart) + two keen
# runners. Pre-grow the backbone was just the ~2km corridor, so the 2nd-longest
# (Ben, 20km) fell far short on a capped corridor; now the spine grows to ~the
# 2nd-longest reach so both reach target WITH the flock. expect_target (Ava ~22 via
# her solo tail) + expect_second_target (Ben ~20 on the grown spine).
s7() {
  local F; F=$(create); echo "s7 → $BASE/flock/$F"
  wp "$F" -37.7980 144.9780 Fitzroy
  wp "$F" -37.7890 144.9950 CliftonHill
  person "$F" Ava -37.7980 144.9775 22 null 360 300 24
  person "$F" Ben -37.7985 144.9785 20 null 360 300 22
  check "$F" "s7 short-corridor 2-keen" 2 1 0 1 1
}

# Edge: ≥2 UNCONSTRAINED runners + waypoints. Reaches are all Infinity, so sizing
# must not return Infinity (the latent crash the L* clamp guards) — backbone falls
# back to the default and both run it together.
s9() {
  local F; F=$(create); echo "s9 → $BASE/flock/$F"
  wp "$F" -37.7980 144.9780 Fitzroy
  wp "$F" -37.7890 144.9950 CliftonHill
  person "$F" Uno -37.7980 144.9775 null null 360 300 null
  person "$F" Dos -37.7985 144.9785 null null 360 300 null
  check "$F" "s9 2-unconstrained + wp" 2 1 0
}

# Edge: a LONG waypoint corridor + small targets → the spine must NOT grow (deficit
# ≤ 0); shorter runners just peel off early. (Confirm via the absence of a "backbone
# grown" log; here we assert it stays structurally valid + within caps.)
s10() {
  local F; F=$(create); echo "s10 → $BASE/flock/$F"
  wp "$F" -37.7850 144.9520 Parkville; wp "$F" -37.8230 144.9680 CBD; wp "$F" -37.8000 145.0050 Abbotsford
  person "$F" Sam -37.7860 144.9530 6 null 360 300 7
  person "$F" Pat -37.7855 144.9525 7 null 360 300 8
  check "$F" "s10 long-corridor small-targets" 2 1 0
}

# Edge: a finish-elsewhere keen runner + waypoints → corridor-aware egress anchors
# to the LAST waypoint, and the runner egresses to their chosen finish, reaching target.
s11() {
  local F; F=$(create); echo "s11 → $BASE/flock/$F"
  wp "$F" -37.7980 144.9780 Fitzroy
  wp "$F" -37.7890 144.9950 CliftonHill
  patch "$F" "{\"action\":\"addParticipant\",\"editToken\":\"Ava\",\"participant\":{\"name\":\"Ava\",\"startLocation\":{\"lat\":-37.798,\"lng\":144.9775},\"startAddress\":\"Ava\",\"earliestStartTime\":\"07:00\",\"finishLocation\":{\"lat\":-37.81,\"lng\":145.01},\"finishAddress\":\"finish\",\"latestFinishTime\":null,\"preferredPace\":360,\"maxPace\":300,\"preferredDistance\":20,\"maxDistance\":22,\"restStop\":null}}"
  person "$F" Ben -37.7985 144.9785 18 null 360 300 20
  check "$F" "s11 finish-elsewhere keen" 2 1 0 1
}

# Ride-to-stop-then-home (partial-dwell exit): a keen, deadline-pressed runner on a
# flock route WITH a café stop. The full dwell would blow their deadline, so they
# ride to the stop and peel off there — keeping the together-time — rather than
# peeling before it; warm-up/cool-down loops still bring them to target. The
# checker's arrival≤latest guard fails if the dwell wrongly busts their deadline.
s12() {
  local F; F=$(create); echo "s12 → $BASE/flock/$F"
  wp "$F" -37.7980 144.9780 Start
  wp "$F" -37.8050 144.9720 Cafe 30
  wp "$F" -37.7840 144.9610 Far
  person "$F" Anchor -37.7980 144.9775 null null    360 300 null
  person "$F" Keen   -37.7985 144.9785 12   '"09:30"' 360 300 14
  check "$F" "s12 ride-to-stop + deadline" 2 1 0 1
}

# Convergent pair (Stage 0 — computed formation point F): two runners funnelling
# down the SAME arterial to the first waypoint (Princes Park), ~3km N and ~300m
# apart, so their shortest ORS approaches share the final corridor. The pin would
# start the spine AT the waypoint and score the shared approach only as a post-hoc
# opportunistic feeder overlap; Stage 0 pulls the rendezvous back to F where they
# merge, making that corridor a first-class shared backbone leg. expect_formation=1
# asserts the spine starts ≥500m before wp0 (F fired). Together-time is preserved
# (opp-overlap already caught the coincidence); this is the cohesive, planned form.
cvg() {
  local F; F=$(create); echo "cvg → $BASE/flock/$F"
  wp "$F" -37.7840 144.9610 PrincesPark
  wp "$F" -37.8050 144.9720 CarltonGardens
  person "$F" Ana -37.7560 144.9590 16 null 360 300 18
  person "$F" Bo  -37.7555 144.9625 15 null 360 300 17
  check "$F" "cvg convergent-pair (F)" 2 1 0 0 0 1
}

# Single-waypoint convergent pair (F/D on a LOOP): the "meet at one café, run a loop"
# case. ONE waypoint (Princes Park) + two runners funnelling down the same arterial.
# The backbone is a loop at the waypoint; F prepends the shared approach BEFORE it and
# D appends the shared egress AFTER it, so the pair flock in and out. expect_formation=1
# asserts the spine starts ≥500m before the waypoint (F fired). Guards that Stage 0
# convergence works for single-waypoint loops, not just multi-waypoint corridors.
sw() {
  local F; F=$(create); echo "sw → $BASE/flock/$F"
  wp "$F" -37.7840 144.9610 PrincesPark
  person "$F" Ana -37.7560 144.9590 12 null 360 300 14
  person "$F" Bo  -37.7555 144.9625 11 null 360 300 13
  check "$F" "sw single-wp convergent (F/D)" 2 1 0 0 0 1
}
# FORCED convergence (Stage 1) — one café, two runners on DIFFERENT roads into it (~50°
# apart) who share no tail, so natural F can't fire. With headroom they're bent to a
# computed meeting point P before the café and run the lead together; together-min jumps
# from ~0 and the spine starts measurably before the waypoint (expect_formation=1).
fwd() {
  local F; F=$(create); echo "fwd → $BASE/flock/$F"
  wp "$F" -37.8284 144.9847 Anderson
  person "$F" REB -37.8067 144.9694 null null 360 300 null   # unconstrained
  person "$F" Nor -37.7812 144.9860 12   null 360 300 13.8   # pref 12 / cap 13.8
  check "$F" "fwd forced-convergence (P)" 2 1 0 0 0 1
}
# FORCED convergence DECLINES — two runners on OPPOSITE sides of the café (~180° apart)
# fall outside the spread ceiling, so no meeting point is synthesised and the model stays
# pinned at the café (no formation point: baseline provably untouched).
fwd0() {
  local F; F=$(create); echo "fwd0 → $BASE/flock/$F"
  wp "$F" -37.8284 144.9847 Anderson
  person "$F" Nth -37.7900 144.9850 12 null 360 300 14   # ~4km N of café
  person "$F" Sth -37.8700 144.9850 12 null 360 300 14   # ~4.5km S of café
  check "$F" "fwd0 forced declines (pinned)" 2 0 0 0 0 0
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
  all) for sc in s1 s2 s3 s4 s5 s6 pc ext s7 s9 s10 s11 s12 cvg sw fwd fwd0 cct; do "$sc"; [ "$sc" = cct ] || sleep "$SLEEP"; done ;;
  *)   "$WHICH" ;;
esac
echo "── $PASS passed, $FAIL failed ──"
exit $(( FAIL > 0 ? 1 : 0 ))
