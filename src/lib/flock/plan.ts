// ---------------------------------------------------------------------------
// Flock — the planner. Pure and ORS-free: given a shared route, the runners' hard
// constraints, and the flock's departure time, it places each runner's participation
// window to maximise summed pairwise co-present minutes, runs the one flock clock
// (slowest-present pace + dwell), and reads off the company blocks.
//
// Route construction (ORS) and projection to the app's CalcResult live elsewhere; this
// is the heart, kept pure so it is deterministically testable.
// ---------------------------------------------------------------------------

import type { Block, Conflict, Plan, Route, RunInput, Runner, RunnerPlan, Warning } from "./model";

const EPS = 1e-6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Window {
  enterKm: number;
  exitKm: number;
}

// --- the flock clock --------------------------------------------------------
// Boundaries at every window edge and every stop; each leg runs at the slowest pace
// among those PRESENT (co-arrival is assumed — a late joiner times their start to meet
// the flock where it passes). A dwell block is charged to everyone continuing past the
// stop. Singletons (one present) are first-class — they advance the clock at their pace.
function computeBlocks(wins: Map<string, Window>, route: Route, runners: Runner[], t0: number): Block[] {
  const total = route.totalKm;
  const paceOf = new Map(runners.map((r) => [r.id, r.pace]));
  const win = (id: string) => wins.get(id)!;
  const maxExit = Math.max(0, ...runners.map((r) => win(r.id).exitKm));

  const bset = new Set<number>([0]);
  for (const r of runners) {
    bset.add(clamp(win(r.id).enterKm, 0, total));
    bset.add(clamp(win(r.id).exitKm, 0, total));
  }
  for (const s of route.stops) if (s.km <= maxExit + EPS) bset.add(clamp(s.km, 0, total));
  const bounds = [...bset].filter((k) => k <= maxExit + EPS).sort((a, b) => a - b);

  const covers = (id: string, lo: number, hi: number) =>
    win(id).enterKm <= lo + EPS && win(id).exitKm >= hi - EPS;
  const present = (lo: number, hi: number) => runners.filter((r) => covers(r.id, lo, hi)).map((r) => r.id);

  const blocks: Block[] = [];
  let clock = t0;
  for (let k = 0; k < bounds.length; k++) {
    const at = bounds[k];
    // A stop is a REUNION: everyone whose CLOSED window [enter,exit] includes it shares the
    // dwell — those passing THROUGH and those FINISHING here (running to the café and stopping
    // for coffee is co-presence, the whole point, not a deviation). The flock rests the full
    // dwell; a continuer leaves with it, a finisher stays for the coffee but no later than their
    // own deadline (less the run home). Split the rest at distinct leave-times so every emitted
    // sub-block keeps uniform membership (and togetherMinutes/projection read it unchanged).
    const dwellSec = route.stops
      .filter((s) => Math.abs(s.km - at) < 1e-3)
      .reduce((sum, s) => sum + s.durationSec, 0);
    if (dwellSec > 0) {
      const atStop = runners.filter((r) => win(r.id).enterKm <= at + EPS && win(r.id).exitKm >= at - EPS);
      const leaveOf = (r: Runner): number => {
        if (win(r.id).exitKm > at + EPS) return clock + dwellSec; // continues — leaves with the flock
        const cap = r.latestSec != null ? r.latestSec - r.egressKm * r.pace : Infinity; // finisher's hard out
        return Math.min(clock + dwellSec, Math.max(clock, cap));
      };
      const leaves = atStop.map((r) => ({ id: r.id, leave: leaveOf(r) }));
      const cuts = [...new Set(leaves.map((l) => l.leave))].filter((t) => t > clock + EPS && t < clock + dwellSec - EPS).sort((a, b) => a - b);
      const segs = [clock, ...cuts, clock + dwellSec];
      for (let s = 0; s < segs.length - 1; s++) {
        const mem = leaves.filter((l) => l.leave >= segs[s + 1] - EPS).map((l) => l.id);
        if (mem.length > 0) blocks.push({ members: mem, loKm: at, hiKm: at, startSec: segs[s], endSec: segs[s + 1], paceSec: null });
      }
      clock += dwellSec;
    }
    if (k >= bounds.length - 1) break;
    const lo = at;
    const hi = bounds[k + 1];
    if (hi - lo < EPS) continue;
    const mem = present(lo, hi);
    if (mem.length === 0) continue; // a gap nobody covers — flock isn't here
    const paceSec = Math.max(...mem.map((id) => paceOf.get(id)!));
    blocks.push({ members: mem, loKm: lo, hiKm: hi, startSec: clock, endSec: clock + (hi - lo) * paceSec, paceSec });
    clock += (hi - lo) * paceSec;
  }
  return blocks;
}

// --- the objective: summed pairwise co-present minutes (moving + dwell) -----
function togetherMinutes(blocks: Block[]): number {
  let m = 0;
  for (const b of blocks) {
    const n = b.members.length;
    if (n < 2) continue;
    m += ((b.endSec - b.startSec) / 60) * (n * (n - 1)) / 2;
  }
  return m;
}

// --- window placement (best-response on the one monotone objective) ---------
// The default optimum is "everyone on the whole route" — adding company and staying
// together longer only ever raises the objective. So unconstrained runners take [0,L]
// and a constrained runner slides their feasible window to where the most company is,
// counting a stop's dwell as the dense together-time it is. Best-response converges fast
// because the objective is benignly monotone (no fairness/pricing tension to oscillate).
function resolveWindows(input: RunInput): Map<string, Window> {
  const { route, runners } = input;
  const L = route.totalKm;
  const refPace = Math.max(360, ...runners.map((r) => r.pace)); // slowest, for time-weighting the scan

  const lowerOf = (r: Runner) => (r.enter.kind === "fixed" ? clamp(r.enter.km, 0, L) : null);
  const upperOf = (r: Runner) => (r.exit.kind === "fixed" ? clamp(r.exit.km, 0, L) : null);
  // "How far can you run" caps the TOTAL distance — both connector commutes to/from a manual
  // pin count against it — so the on-spine arc may be at most (cap − approach − egress).
  const arcCapOf = (r: Runner) => (r.maxDistanceKm != null ? Math.max(0, r.maxDistanceKm - r.approachKm - r.egressKm) : null);
  const wins = new Map<string, Window>();
  for (const r of runners) {
    const lo = lowerOf(r) ?? 0;
    let hi = upperOf(r) ?? L;
    const ac = arcCapOf(r);
    if (ac != null) hi = Math.min(hi, lo + ac);
    wins.set(r.id, { enterKm: lo, exitKm: Math.max(lo, hi) });
  }

  // Only runners with genuine freedom need solving (a free end and/or a slack cap).
  const free = runners.filter((r) => {
    const ac = arcCapOf(r);
    return r.enter.kind === "free" || r.exit.kind === "free" || (ac != null && ac < L - EPS);
  });
  if (free.length === 0) return wins;

  const N = clamp(Math.round(L / 0.25), 16, 200);
  const seg = L / N;
  const pos = Array.from({ length: N + 1 }, (_, k) => k * seg);
  const idx = (km: number) => clamp(Math.round(km / seg), 0, N);

  for (let round = 0; round < 4; round++) {
    let moved = false;
    for (const r of free) {
      // presence of the OTHERS over the segment grid (+ at each stop)
      const present = new Array(N).fill(0);
      for (const o of runners) {
        if (o.id === r.id) continue;
        const w = wins.get(o.id)!;
        for (let k = 0; k < N; k++) if (w.enterKm <= pos[k] + EPS && w.exitKm >= pos[k + 1] - EPS) present[k]++;
      }
      const prefix = new Array(N + 1).fill(0); // time-weighted others-present integral
      for (let k = 0; k < N; k++) prefix[k + 1] = prefix[k] + present[k] * seg * refPace;
      const stopBonus = (a: number, b: number) =>
        route.stops.reduce((s, st) => {
          if (st.km <= a + EPS || st.km >= b - EPS) return s;
          let others = 0;
          for (const o of runners) {
            if (o.id === r.id) continue;
            const w = wins.get(o.id)!;
            if (w.enterKm <= st.km + EPS && w.exitKm > st.km + EPS) others++;
          }
          return s + others * st.durationSec;
        }, 0);

      const lo = lowerOf(r);
      const hi = upperOf(r);
      const cap = arcCapOf(r) ?? Infinity;
      const enters = lo != null ? [idx(lo)] : Array.from({ length: N + 1 }, (_, k) => k);
      let best = wins.get(r.id)!;
      let bestScore = -1;
      for (const ei of enters) {
        const xiMax = hi != null ? idx(hi) : N;
        for (let xi = ei; xi <= xiMax; xi++) {
          if (pos[xi] - pos[ei] > cap + EPS) break;
          const score = prefix[xi] - prefix[ei] + stopBonus(pos[ei], pos[xi]);
          // tie-break toward a LONGER window (more shared distance) so a runner with
          // company still runs rather than collapsing to zero arc.
          const arc = pos[xi] - pos[ei];
          const curArc = best.exitKm - best.enterKm;
          if (score > bestScore + EPS || (Math.abs(score - bestScore) <= EPS && arc > curArc + EPS)) {
            best = { enterKm: pos[ei], exitKm: pos[xi] };
            bestScore = score;
          }
        }
      }
      // The coarse scan grid only places FREE bounds; a FIXED bound (a pin to a waypoint or a
      // manual point) must keep its EXACT km so a finish pinned to a café waypoint lands ON that
      // café's stop (not grid-snapped 100 m short, which would silently drop the reunion).
      const next = {
        enterKm: lo != null ? lo : best.enterKm,
        exitKm: hi != null ? hi : best.exitKm,
      };
      next.exitKm = Math.max(next.enterKm, next.exitKm);
      // Respect the distance cap even when a bound is FIXED: pull the FREE end in so the arc
      // never exceeds the cap (a finish pin past the cap → start later, not run past the cap).
      // Both-ends-pinned-over-cap is genuinely impossible and is flagged in classify().
      if (cap < Infinity && next.exitKm - next.enterKm > cap + EPS) {
        if (lo == null) next.enterKm = next.exitKm - cap;
        else if (hi == null) next.exitKm = next.enterKm + cap;
      }
      next.enterKm = clamp(next.enterKm, 0, L);
      next.exitKm = clamp(Math.max(next.enterKm, next.exitKm), 0, L);
      const cur = wins.get(r.id)!;
      if (Math.abs(next.enterKm - cur.enterKm) > EPS || Math.abs(next.exitKm - cur.exitKm) > EPS) moved = true;
      wins.set(r.id, next);
    }
    if (!moved) break;
  }
  return wins;
}

// --- latest-finish: trim exits so nobody arrives past their deadline --------
function enforceDeadlines(wins: Map<string, Window>, route: Route, runners: Runner[], t0: number): void {
  for (let pass = 0; pass < 4; pass++) {
    const blocks = computeBlocks(wins, route, runners, t0);
    let changed = false;
    for (const r of runners) {
      if (r.latestSec == null) continue;
      const w = wins.get(r.id)!;
      if (w.exitKm - w.enterKm < EPS) continue;
      const span = runnerSpan(blocks, r.id);
      if (!span) continue;
      // When they actually FINISH (leave their last block) + the run home. For a finisher at a
      // dwell, leaveOf already capped this to the deadline, so no trim is needed — the reunion
      // is kept, not cut.
      const arrive = span.last + r.egressKm * r.pace;
      if (arrive <= r.latestSec + EPS) continue;
      // Default: trim the exit proportionally to the overshoot (peel off earlier on the arc).
      const over = arrive - r.latestSec;
      let newExit = Math.max(w.enterKm, w.exitKm - over / r.pace);
      // But if a dwell STOP inside the window is still reachable in time, FINISHING there beats
      // peeling off at a bare point: the runner reaches the café with the flock and stays for the
      // reunion (capped by their deadline) instead of being evicted before it by slowest-wins.
      // Snap to the FARTHEST such stop past the bare trim. (Reachable = the flock arrives at the
      // stop early enough that the runner can be there, then run home, by their deadline.)
      for (const s of route.stops) {
        if (s.km <= newExit + EPS || s.km > w.exitKm + EPS || s.km < w.enterKm - EPS) continue;
        const cafeArrival = dwellStartAt(blocks, s.km);
        if (cafeArrival != null && cafeArrival + r.egressKm * r.pace <= r.latestSec + EPS) newExit = s.km;
      }
      if (w.exitKm - newExit > 0.05) {
        wins.set(r.id, { enterKm: w.enterKm, exitKm: newExit });
        changed = true;
      }
    }
    if (!changed) break;
  }
}

// --- earliest-start: a runner can't leave home before their floor -----------
// Push the join point forward to where the flock passes at/after (earliest + their
// connector run), so they co-arrive without setting off too early. The mirror of
// enforceDeadlines — a LOWER bound on the join rather than an upper bound on the leave.
function enforceEarliest(wins: Map<string, Window>, route: Route, runners: Runner[], t0: number): void {
  for (let pass = 0; pass < 4; pass++) {
    const blocks = computeBlocks(wins, route, runners, t0);
    let changed = false;
    for (const r of runners) {
      if (r.earliestSec == null) continue;
      const w = wins.get(r.id)!;
      if (w.exitKm - w.enterKm < EPS) continue;
      const span = runnerSpan(blocks, r.id);
      if (!span) continue;
      const couldDepart = span.first - r.approachKm * r.pace; // when they'd have to leave now
      if (couldDepart >= r.earliestSec - EPS) continue;
      const newEnter = Math.min(w.exitKm, Math.max(w.enterKm, kmAtTime(blocks, r.earliestSec + r.approachKm * r.pace)));
      if (newEnter - w.enterKm > 0.05) {
        wins.set(r.id, { enterKm: newEnter, exitKm: w.exitKm });
        changed = true;
      }
    }
    if (!changed) break;
  }
}

// first arc km the flock reaches at or after wall-clock time T (inverse of arrivalAt)
function kmAtTime(blocks: Block[], T: number): number {
  let last = 0;
  for (const b of blocks) {
    last = Math.max(last, b.hiKm);
    if (b.paceSec == null) {
      if (b.endSec >= T - EPS) return b.loKm;
      continue;
    }
    if (b.endSec >= T - EPS) {
      if (b.startSec >= T) return b.loKm;
      return b.loKm + ((T - b.startSec) / (b.endSec - b.startSec)) * (b.hiKm - b.loKm);
    }
  }
  return last;
}

// flock-clock seconds when the flock reaches `km` (start of the leg/dwell containing it)
export function arrivalAt(blocks: Block[], km: number): number {
  let best = 0;
  for (const b of blocks) {
    if (b.paceSec == null) {
      if (b.loKm <= km + EPS) best = Math.max(best, b.startSec);
      continue;
    }
    if (km >= b.hiKm - EPS) best = Math.max(best, b.endSec);
    else if (km >= b.loKm - EPS) best = Math.max(best, b.startSec + (km - b.loKm) * b.paceSec);
  }
  return best;
}

// A runner's actual participation span = [start of their first block, end of their last].
// This is THE source of per-runner timing: it reads the schedule the engine actually built,
// so it's correct across opening/closing dwells, a finish-at-a-stop reunion, and a dwell split
// by a deadline — cases where arrivalAt(km) (the LATEST flock-clock at a km) would mislead,
// e.g. a finisher's exit km is also the start of the post-dwell leg they DON'T run. Null when
// the runner has no block (a degenerate zero-span window).
export function runnerSpan(blocks: Block[], id: string): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const b of blocks) {
    if (!b.members.includes(id)) continue;
    first = Math.min(first, b.startSec);
    last = Math.max(last, b.endSec);
  }
  return first === Infinity ? null : { first, last };
}

// Flock-clock seconds the flock ARRIVES at a dwell stop (the start of its rest) — distinct
// from arrivalAt(km), whose max-semantics returns the post-dwell leg time at that km. Null if
// no dwell sits at km. Used to ask "can a deadline-bound runner reach this café in time?".
function dwellStartAt(blocks: Block[], km: number): number | null {
  let start: number | null = null;
  for (const b of blocks) {
    if (b.paceSec != null || Math.abs(b.loKm - km) > 1e-3) continue;
    start = start == null ? b.startSec : Math.min(start, b.startSec);
  }
  return start;
}

// A plain-English reason a runner's constraints can't be honoured — named, never silent (D3).
function conflictMessage(c: Conflict): string {
  switch (c.kind) {
    case "cap-vs-pin": {
      // Name all the numbers (the spec's "don't pick a winner"): the pin separation and the cap.
      const { enterPinKm: lo, exitPinKm: hi, capKm } = c;
      const detail = lo != null && hi != null
        ? `Your start and finish points are about ${Math.abs(hi - lo).toFixed(1)} km apart`
        : `Your ${hi != null ? "finish" : "start"} point is about ${(hi ?? lo ?? 0).toFixed(1)} km along`;
      return `${detail} but your distance limit is ${capKm.toFixed(1)} km — they can't both hold, so we couldn't place you on this run.`;
    }
    case "cap-too-short":
      return c.commuteKm > c.capKm + EPS
        ? `Getting to and from your start/finish point is about ${c.commuteKm.toFixed(1)} km, but your distance limit is ${c.capKm.toFixed(1)} km — so we couldn't place you on this run.`
        : `Your distance limit of ${c.capKm.toFixed(1)} km leaves no room to run with the flock, so we couldn't place you on this run.`;
    case "earliest-after-latest":
      return "Your earliest start is after your latest finish — there's no window to run, so we couldn't place you on this run.";
    case "latest-unreachable":
      return "The run starts too late for you to finish by your deadline, so we couldn't place you on this run.";
    case "window-empty":
      return "Your limits leave no room to run on this route, so we couldn't place you on this run.";
  }
}

// --- warnings: name every infeasibility; flag the lonely; silent on the happy path ----------
// A PARKED (infeasible) runner is named with its conflict. A short-covered FEASIBLE runner is
// "lonely"/"with the flock" ONLY when there is a flock (≥2 feasible participants) — a solo
// runner has no flock to be told about. A full-route runner gets no warning.
function buildWarnings(runners: Runner[], plans: RunnerPlan[], routeKm: number): Warning[] {
  const out: Warning[] = [];
  const byId = new Map(runners.map((r) => [r.id, r]));
  const feasibleCount = plans.filter((p) => p.conflict == null).length;
  for (const p of plans) {
    const r = byId.get(p.id)!;
    if (p.conflict != null) {
      out.push({ id: p.id, message: conflictMessage(p.conflict) });
      continue;
    }
    const covered = p.exitKm - p.enterKm;
    if (covered >= routeKm - 0.3) continue; // full-route runner: no warning
    if (feasibleCount <= 1) continue; // no flock to be lonely from
    if (p.togetherMinutes < 1) {
      out.push({ id: p.id, message: "You barely overlap with anyone — pin your start to a waypoint the flock passes to join them." });
    } else {
      const why = r.latestSec != null ? "to be done in time" : r.earliestSec != null ? "from when you can start" : r.maxDistanceKm != null ? "to stay within your distance" : "where you join/leave";
      out.push({ id: p.id, message: `You're with the flock for ${covered.toFixed(1)} of ${routeKm.toFixed(1)} km — ${why}.` });
    }
  }
  return out;
}

// --- logic-driven auto start ------------------------------------------------
// Choose the flock's departure (km-0 clock) when the user leaves the time on "Auto".
// The objective (summed co-present minutes) is translation-invariant in t0 EXCEPT where a
// runner's earliest/latest constraint clips their window — so the only t0 values that can
// matter are the constraint breakpoints. We evaluate the REAL planner at each and keep the
// best: more togetherness first, then more total participation (so a lone constrained runner
// still runs the whole route rather than a truncated tail), tie-broken toward a "nice" 07:00.
// With no constraints there's a single candidate (07:00) — so Auto stays 7am unless a
// constraint genuinely lets a different start do better.
const DEFAULT_AUTO_T0 = 7 * 3600; // 07:00
export function resolveAutoStart(route: Route, runners: Runner[]): number {
  const earliest = runners.map((r) => r.earliestSec).filter((s): s is number => s != null);
  const latest = runners.map((r) => r.latestSec).filter((s): s is number => s != null);
  if (earliest.length === 0 && latest.length === 0) return DEFAULT_AUTO_T0;

  // Full-route duration (slowest pace over the whole arc + all dwell) — the auto default is
  // everyone running the whole route, so a deadline l means "start by l − this".
  const slowest = Math.max(360, ...runners.map((r) => r.pace));
  const dwellSec = route.stops.reduce((s, st) => s + st.durationSec, 0);
  const fullRunSec = route.totalKm * slowest + dwellSec;

  const cands = new Set<number>([DEFAULT_AUTO_T0]);
  for (const e of earliest) cands.add(Math.max(0, e));
  for (const l of latest) cands.add(Math.max(0, l - fullRunSec));

  let bestT0 = DEFAULT_AUTO_T0;
  let bestTog = -1;
  let bestDist = -1;
  let bestNear = Infinity;
  for (const t0 of [...cands].sort((a, b) => a - b)) {
    const plan = planRun({ route, runners, t0Sec: t0 });
    const tog = plan.togetherMinutes;
    const dist = plan.runners.reduce((s, p) => s + Math.max(0, p.exitKm - p.enterKm), 0);
    const near = Math.abs(t0 - DEFAULT_AUTO_T0);
    // Lexicographic: maximise togetherness, then participation distance, then nearness to 07:00.
    const better =
      tog > bestTog + EPS ||
      (Math.abs(tog - bestTog) <= EPS &&
        (dist > bestDist + EPS ||
          (Math.abs(dist - bestDist) <= EPS && near < bestNear - EPS)));
    if (better) {
      bestT0 = t0;
      bestTog = tog;
      bestDist = dist;
      bestNear = near;
    }
  }
  return bestT0;
}

// --- feasibility verdict ----------------------------------------------------
// Is this runner's set of HARD constraints mutually satisfiable AT THIS t0? Pure from the
// runner + t0 (no window needed): the three genuine contradictions. A runner that classifies
// to a Conflict is PARKED, not silently fabricated a window. Returns null = a real participant.
function classify(r: Runner, t0: number, L: number): Conflict | null {
  const approachSec = r.approachKm * r.pace;
  const egressSec = r.egressKm * r.pace;
  // Earliest-after-latest, connector-aware: can't leave before earliest AND be home by latest.
  if (r.earliestSec != null && r.latestSec != null && r.earliestSec + approachSec > r.latestSec - egressSec + EPS)
    return { kind: "earliest-after-latest", earliestSec: r.earliestSec, latestSec: r.latestSec };
  // The flock departs so late this runner can't make their deadline even doing nothing but the
  // connector commute (covers an impossible deadline AND a flock pushed late by another runner).
  if (r.latestSec != null && t0 + approachSec + egressSec > r.latestSec + EPS)
    return { kind: "latest-unreachable", latestSec: r.latestSec, t0Sec: t0 };
  // The mandatory connector commute (approach + egress) ALONE exceeds the distance cap, or the cap
  // is ~0 with a pinned end — the runner cannot get to/from the route and run within their limit.
  // (cap≈0 with BOTH ends free is the intended zero-arc co-arriver, MIN-F3 — left feasible.)
  if (r.maxDistanceKm != null && (r.approachKm + r.egressKm > r.maxDistanceKm + EPS || (r.maxDistanceKm < EPS && (r.enter.kind === "fixed" || r.exit.kind === "fixed"))))
    return { kind: "cap-too-short", capKm: r.maxDistanceKm, commuteKm: r.approachKm + r.egressKm };
  // Both ends pinned but their separation exceeds the distance cap — neither can be honoured.
  if (r.enter.kind === "fixed" && r.exit.kind === "fixed" && r.maxDistanceKm != null) {
    const lo = clamp(r.enter.km, 0, L), hi = clamp(r.exit.km, 0, L);
    const arcCap = Math.max(0, r.maxDistanceKm - r.approachKm - r.egressKm);
    if (Math.abs(hi - lo) > arcCap + EPS)
      return { kind: "cap-vs-pin", capKm: r.maxDistanceKm, enterPinKm: lo, exitPinKm: hi };
  }
  return null;
}

// --- the entry point --------------------------------------------------------
export function planRun(input: RunInput): Plan {
  const { route, runners, t0Sec } = input;
  const L = route.totalKm;

  // Feasibility is a value, not a forgotten case. Infeasible runners are set aside (never
  // placed into the geometry/timing pipeline, where they'd pollute the flock or read off a
  // fabricated clock); they are PARKED below with a named conflict.
  const verdict = new Map(runners.map((r) => [r.id, classify(r, t0Sec, L)] as const));
  const feasible = runners.filter((r) => verdict.get(r.id) == null);

  const wins = resolveWindows({ route, runners: feasible, t0Sec });
  enforceEarliest(wins, route, feasible, t0Sec);
  enforceDeadlines(wins, route, feasible, t0Sec);
  const blocks = computeBlocks(wins, route, feasible, t0Sec);

  // per-runner share of together-time
  const share = new Map(runners.map((r) => [r.id, 0]));
  for (const b of blocks) {
    if (b.members.length < 2) continue;
    const min = (b.endSec - b.startSec) / 60;
    for (const id of b.members) share.set(id, share.get(id)! + min);
  }

  // Does any built block reach this arc km (i.e. is the flock actually there)? Distinguishes a
  // zero-arc runner who CO-ARRIVES where the flock passes (connector-only / cap-exhausted-by-
  // connector — anchor at the flock's clock there) from one with no flock at their point at all
  // (the F1 case — park, never read a fabricated 0).
  const reaches = (km: number) => blocks.some((b) => b.loKm - EPS <= km && km <= b.hiKm + EPS);

  const plans: RunnerPlan[] = runners.map((r) => {
    let conflict = verdict.get(r.id) ?? null;
    if (conflict == null) {
      const w = wins.get(r.id)!;
      // Timing reads the runner's ACTUAL span in the built schedule: leave home to reach the first
      // block as it starts (minus approach), arrive home after the last block (plus egress) — what
      // makes an opening dwell, a finish-at-café reunion, and a deadline-trimmed dwell time correct.
      // A zero-arc runner with no block of their own but whose point the flock passes is a genuine
      // CO-ARRIVAL (connector-only / cap-exhausted) — timed off the flock clock there, never a 0.
      const span = runnerSpan(blocks, r.id);
      const timing = span != null
        ? { departSec: span.first - r.approachKm * r.pace, arriveSec: span.last + r.egressKm * r.pace }
        : reaches(w.enterKm)
          ? { departSec: arrivalAt(blocks, w.enterKm) - r.approachKm * r.pace, arriveSec: arrivalAt(blocks, w.exitKm) + r.egressKm * r.pace }
          : null;
      if (timing != null) {
        const distanceKm = w.exitKm - w.enterKm + r.approachKm + r.egressKm;
        // Validate the resolved ARRIVAL against the runner's deadline before declaring them a
        // participant. A zero-span window escapes enforceDeadlines' trim (it skips collapsed
        // windows), so the co-arrival path above would otherwise emit a clock HOURS past latestSec
        // with conflict=null (the F2 wound). Honour the deadline by NAMING it and parking instead.
        // (Earliest is NOT enforced here — it is honoured by raising the flock start, not parking.
        // The distance cap is NOT a hard ceiling on the connector commute: a manual-pin approach is
        // mandatory overhead that may push the total slightly over the cap — see _st_connectors #9.)
        if (r.latestSec != null && timing.arriveSec > r.latestSec + 60)
          conflict = { kind: "latest-unreachable", latestSec: r.latestSec, t0Sec };
        else
          return {
            id: r.id, enterKm: w.enterKm, exitKm: w.exitKm,
            departSec: timing.departSec, arriveSec: timing.arriveSec,
            distanceKm, togetherMinutes: share.get(r.id)!, conflict: null,
          };
      }
    }
    // PARK — a clearly-minimal result anchored to the runner's OWN tightest hard floor (never a
    // fabricated 0, a borrowed clock, or a wrapped negative). Either a named conflict (from classify
    // or the HARD re-validation above), or a squeezed-out window with no flock near their point.
    const parkKm = r.enter.kind === "fixed" ? clamp(r.enter.km, 0, L) : r.exit.kind === "fixed" ? clamp(r.exit.km, 0, L) : 0;
    const floor = Math.max(t0Sec, r.earliestSec ?? -Infinity);
    return { id: r.id, enterKm: parkKm, exitKm: parkKm, departSec: floor, arriveSec: floor, distanceKm: 0, togetherMinutes: 0, conflict: conflict ?? { kind: "window-empty" } };
  });

  return {
    blocks,
    runners: plans,
    togetherMinutes: togetherMinutes(blocks),
    warnings: buildWarnings(runners, plans, route.totalKm),
  };
}
