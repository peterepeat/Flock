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
// Grace on the HARD clock checks: a runner within this much of its deadline/earliest reads as "on
// time" and is not parked. The values match the G1/G2 acceptance oracles in _st_combo (display is
// floored to the minute, so sub-minute slop is invisible). On Auto, resolveAutoStart drives the
// departure to exactly the earliest, so this grace only ever absorbs an unslidable fixed-t0 offset.
const LATEST_GRACE_SEC = 60;
const EARLIEST_GRACE_SEC = 90;
// "How far can you run" caps the TOTAL distance — both connector commutes to/from a manual pin count
// against it — so the on-spine arc may be at most (cap − approach − egress). null = no cap.
const arcCapOf = (r: Runner) => (r.maxDistanceKm != null ? Math.max(0, r.maxDistanceKm - r.approachKm - r.egressKm) : null);
// resolveAutoStart's lexicographic cost: one PARKED runner must out-cost any summed earliest-shortfall
// among feasible runners. Feasible shortfall is ≤ EARLIEST_GRACE_SEC each (the rest park), so a
// full-day penalty dominates for any realistic flock — i.e. "keep everyone running" beats "start nicer".
const PARK_PENALTY = 86400;
// Convergence cap for the best-response / projector fixpoints (resolveWindows, enforce*). Each loop
// breaks early on no-change; the bound only guards a slowest-wins cascade. Not a tuned value.
const FIXPOINT_PASSES = 4;

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

  for (let round = 0; round < FIXPOINT_PASSES; round++) {
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
  for (let pass = 0; pass < FIXPOINT_PASSES; pass++) {
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
  for (let pass = 0; pass < FIXPOINT_PASSES; pass++) {
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
    case "earliest-unreachable":
      // Three honest sub-cases (see earliestCause). Every branch keeps "the flock can wait for you"
      // (the Auto-delay remedy unique to earliest-unreachable — _st_combo's G3 oracle keys on it).
      switch (c.cause) {
        case "approach":
          return "Your start point is too far from the route to reach the flock by your earliest start — you'd have to set off before then, so we couldn't place you on this run. Try an Auto start (the flock can wait for you) or move your start closer.";
        case "dwell":
          return "The flock is resting at your join point at your earliest start, but we can't add you partway through its stop, so we couldn't place you on this run. Try an Auto start — the flock can wait for you.";
        case "passed":
          return "The flock passes your join point before your earliest start and has moved on by the time you can set off, so we couldn't place you on this run. Try an Auto start (the flock can wait for you) or a start point the flock reaches later.";
      }
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
// Choose the flock's departure (km-0 clock) when the user leaves the time on "Auto". The objective
// (summed co-present minutes) is translation-invariant in t0 EXCEPT between the runners' earliest/
// latest breakpoints, where a constraint clips someone's window — so t0 only matters inside the window
// those breakpoints span. We pick the t0 that, on the REAL plan, is best lexicographically:
//   1. HONOURS EARLIEST — nobody sets off before their earliest (delay the flock rather than drag a
//      runner out early). This one key subsumes what used to be a separate "t0 floor": a candidate
//      that respects every earliest beats one that doesn't, so the search settles at/above the
//      earliest-feasible start on its own. (An earliest that's unreachable at a FIXED user start is a
//      different path — planRun parks + names it; here on Auto we just wait.)
//   2. more togetherness · 3. more participation distance · 4. nearer a "nice" 07:00.
// The objective is piecewise-linear in t0 with kinks at the breakpoints AND at dwell/deadline
// crossings we don't enumerate in closed form, so a coarse grid over the window plus a local refine
// brackets the optimum without special-casing any one kind of kink. No constraints ⇒ 07:00.
const DEFAULT_AUTO_T0 = 7 * 3600; // 07:00
export function resolveAutoStart(route: Route, runners: Runner[]): number {
  const earliest = runners.map((r) => r.earliestSec).filter((s): s is number => s != null);
  const latest = runners.map((r) => r.latestSec).filter((s): s is number => s != null);
  if (earliest.length === 0 && latest.length === 0) return DEFAULT_AUTO_T0;

  // Full-route duration (slowest pace over the whole arc + all dwell): a deadline l begins to clip at
  // t0 = l − fullRunSec (start any later and the full route can't finish by l).
  const slowest = Math.max(360, ...runners.map((r) => r.pace));
  const dwellSec = route.stops.reduce((s, st) => s + st.durationSec, 0);
  const fullRunSec = route.totalKm * slowest + dwellSec;
  const byId = new Map(runners.map((r) => [r.id, r] as const));

  // Score a t0 from the REAL plan. `cost` is hard-constraint dissatisfaction: a runner who is PARKED
  // (excluded — any reason) is the worst outcome (we'd rather start when everyone can run), then the
  // seconds any feasible runner would still set off before its earliest. Minimising cost subsumes the
  // earliest "floor" (an early or earliest-parked runner raises cost, so the search delays the flock)
  // AND deadline handling (a too-late start parks a deadline runner, raising cost) — one rule, not a
  // pile of special cases. Then maximise togetherness, then participation distance, then nearness 07:00.
  const score = (t0: number) => {
    const plan = planRun({ route, runners, t0Sec: t0 });
    let cost = 0;
    for (const p of plan.runners) {
      if (p.conflict != null) { cost += PARK_PENALTY; continue; } // an excluded runner dominates the cost
      const r = byId.get(p.id)!;
      if (r.earliestSec != null && p.departSec < r.earliestSec) cost += r.earliestSec - p.departSec;
    }
    const dist = plan.runners.reduce((s, p) => s + Math.max(0, p.exitKm - p.enterKm), 0);
    return { t0, cost, tog: plan.togetherMinutes, dist, near: Math.abs(t0 - DEFAULT_AUTO_T0) };
  };
  type S = ReturnType<typeof score>;
  const better = (a: S, b: S): boolean =>
    a.cost < b.cost - EPS ||
    (Math.abs(a.cost - b.cost) <= EPS &&
      (a.tog > b.tog + EPS ||
        (Math.abs(a.tog - b.tog) <= EPS &&
          (a.dist > b.dist + EPS || (Math.abs(a.dist - b.dist) <= EPS && a.near < b.near - EPS)))));

  // Search the window the breakpoints span (the objective is flat outside it): a coarse grid, then a
  // local refine around the winner to bracket a between-breakpoint kink. The window must reach high
  // enough to HONOUR every earliest: at t0 = earliest + approach·pace a runner departs no earlier than
  // earliest even with a fixed off-route approach (arrivalAt(enterKm) ≥ t0 ⇒ depart ≥ t0 − approach·pace
  // = earliest), so that is a safe upper bracket for the earliest "floor"; the search then settles back
  // down to the best feasible t0 within [lo, hi].
  const bps = [
    DEFAULT_AUTO_T0,
    ...earliest, // lower edge: an earliest starts clipping here
    ...latest, // upper edge: above a deadline everyone past it parks — bounds the useful window
    ...latest.map((l) => l - fullRunSec), // a deadline begins to clip a full-route start here
    ...runners.flatMap((r) => (r.earliestSec != null ? [r.earliestSec + r.approachKm * r.pace] : [])), // earliest floor
  ].filter((t) => t >= 0);
  const lo = Math.min(...bps), hi = Math.max(...bps);
  // Evaluate the exact breakpoints (an optimum — e.g. an earliest floor — often sits ON one) AND a
  // coarse grid over the window (for the dwell/deadline kinks between breakpoints), keeping every
  // score; then refine finely around the winner AND any equally-good coarse cell (a between-breakpoint
  // optimum can live next to a different, equal-cost cell than the one `best` happens to hold).
  const coarse = Math.max(120, Math.round((hi - lo) / 32));
  const fine = Math.max(15, Math.round(coarse / 10));
  const grid: S[] = [];
  let best = score(DEFAULT_AUTO_T0);
  grid.push(best);
  const consider = (t: number) => { const s = score(Math.max(0, t)); grid.push(s); if (better(s, best)) best = s; };
  for (const t of bps) consider(t);
  for (let t = lo; t <= hi + EPS; t += coarse) consider(t);
  const anchors = [best.t0, ...grid.filter((g) => Math.abs(g.cost - best.cost) <= EPS).map((g) => g.t0)];
  for (const a of anchors) for (let t = a - coarse; t <= a + coarse + EPS; t += fine) consider(t);
  return best.t0;
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
    if (Math.abs(hi - lo) > (arcCapOf(r) ?? 0) + EPS)
      return { kind: "cap-vs-pin", capKm: r.maxDistanceKm, enterPinKm: lo, exitPinKm: hi };
  }
  return null;
}

// --- the entry point --------------------------------------------------------
export function planRun(input: RunInput): Plan {
  const { route, runners, t0Sec } = input;
  const L = route.totalKm;

  // Feasibility is a value, not a forgotten case. A runner with contradictory hard constraints is set
  // aside up front by classify(); a runner whose RESOLVED clock still busts a deadline/earliest (a
  // zero-span window escapes the enforce* trims) is set aside by the post-hoc check below. BOTH are
  // decided BEFORE the togetherness objective is built, so a parked runner never pollutes the others'
  // company — it contributes no block, no share, no companionId. Never a fabricated/borrowed clock.
  const verdict = new Map(runners.map((r) => [r.id, classify(r, t0Sec, L)] as const));
  const feasible = runners.filter((r) => verdict.get(r.id) == null);

  const wins = resolveWindows({ route, runners: feasible, t0Sec });
  enforceEarliest(wins, route, feasible, t0Sec);
  enforceDeadlines(wins, route, feasible, t0Sec);

  // A runner's timing read off a built schedule: their own SPAN if they hold a block; else a genuine
  // CO-ARRIVAL where the flock passes their (zero-arc) point (connector-only / cap-exhausted) — timed
  // off the flock clock there, never a fabricated 0; else null (no block, flock never there). Reading
  // the span (not arrivalAt(km)) is what times an opening dwell, a finish-at-café reunion, and a
  // deadline-trimmed dwell correctly.
  const timingOf = (r: Runner, blocks: Block[]) => {
    const w = wins.get(r.id)!;
    const span = runnerSpan(blocks, r.id);
    if (span != null) return { w, departSec: span.first - r.approachKm * r.pace, arriveSec: span.last + r.egressKm * r.pace };
    if (blocks.some((b) => b.loKm - EPS <= w.enterKm && w.enterKm <= b.hiKm + EPS))
      return { w, departSec: arrivalAt(blocks, w.enterKm) - r.approachKm * r.pace, arriveSec: arrivalAt(blocks, w.exitKm) + r.egressKm * r.pace };
    return null;
  };
  // A HARD clock contradiction on the resolved timing → a named park. The latest test also catches a
  // zero-DISTANCE co-arriver landing AT its deadline (arc 0, arrive = deadline): a non-participant
  // dressed as one (the knife-edge the strict `> latest+grace` misses). EARLIEST: a fixed t0 that sets
  // the runner off before they can — on Auto, resolveAutoStart delays the flock so this never arises.
  // WHY a runner's earliest can't be met — so the warning is accurate, not a blanket "your start
  // point is too far to catch up" (which is FALSE for a free start sitting at a stop the flock is
  // resting at). Three honest cases, read off the SAME survivor blocks the park is decided on:
  //   approach — the flock IS at the join point at/after the earliest; the connector commute is what
  //              forces the early set-off (the genuine far-approach case).
  //   dwell    — the flock is RESTING at the join point across the earliest; the runner could join
  //              mid-rest, but a mid-stop join isn't scheduled yet (the deferred joinOf split).
  //   passed   — the flock reached the join point and moved on before the earliest.
  const earliestCause = (r: Runner, t: { departSec: number; w: Window }, blocks: Block[]): "approach" | "passed" | "dwell" => {
    const flockAtJoin = t.departSec + r.approachKm * r.pace; // flock-clock when it reaches the join km
    if (flockAtJoin >= r.earliestSec! - EARLIEST_GRACE_SEC) return "approach";
    const dwellStart = dwellStartAt(blocks, t.w.enterKm);
    if (dwellStart != null) {
      const dwellSec = route.stops.filter((s) => Math.abs(s.km - t.w.enterKm) < 1e-3).reduce((sum, s) => sum + s.durationSec, 0);
      if (r.earliestSec! <= dwellStart + dwellSec + EARLIEST_GRACE_SEC) return "dwell";
    }
    return "passed";
  };
  const clockConflict = (r: Runner, t: { departSec: number; arriveSec: number; w: Window }, blocks: Block[]): Conflict | null => {
    const distanceKm = t.w.exitKm - t.w.enterKm + r.approachKm + r.egressKm;
    if (r.latestSec != null && (t.arriveSec > r.latestSec + LATEST_GRACE_SEC || (distanceKm < EPS && t.arriveSec >= r.latestSec - EPS)))
      return { kind: "latest-unreachable", latestSec: r.latestSec, t0Sec };
    if (r.earliestSec != null && t.departSec < r.earliestSec - EARLIEST_GRACE_SEC)
      return { kind: "earliest-unreachable", earliestSec: r.earliestSec, t0Sec, cause: earliestCause(r, t, blocks) };
    return null;
  };

  // Decide the post-hoc parks as a FIXPOINT over the SURVIVOR blocks: build the blocks, park any runner
  // whose RESOLVED timing busts a hard clock (or who holds no block at all), rebuild over the remaining
  // survivors, repeat. Removing a runner can only speed the flock up (fewer slowest-wins members), so
  // others may then set off before their earliest — a single pass over a provisional plan could leave a
  // survivor violating on the rebuilt blocks it is finally timed against. The fixpoint is MONOTONE
  // (parks only ever grow) so it converges; the objective below reads the final survivor blocks, with no
  // parked runner polluting it. The verdict is then sticky — the per-runner loop only reads postHoc.
  const postHoc = new Map<string, Conflict>();
  let blocks = computeBlocks(wins, route, feasible, t0Sec);
  for (let pass = 0; pass <= feasible.length; pass++) {
    let added = false;
    for (const r of feasible) {
      if (postHoc.has(r.id)) continue;
      const t = timingOf(r, blocks);
      const c: Conflict | null = t == null ? { kind: "window-empty" } : clockConflict(r, t, blocks);
      if (c != null) { postHoc.set(r.id, c); added = true; }
    }
    if (!added) break;
    blocks = computeBlocks(wins, route, feasible.filter((rr) => !postHoc.has(rr.id)), t0Sec);
  }

  // per-runner share of together-time (over the survivor blocks)
  const share = new Map(runners.map((r) => [r.id, 0]));
  for (const b of blocks) {
    if (b.members.length < 2) continue;
    const min = (b.endSec - b.startSec) / 60;
    for (const id of b.members) share.set(id, share.get(id)! + min);
  }

  const plans: RunnerPlan[] = runners.map((r) => {
    const conflict = verdict.get(r.id) ?? postHoc.get(r.id) ?? null;
    if (conflict == null) {
      const t = timingOf(r, blocks);
      if (t != null)
        return {
          id: r.id, enterKm: t.w.enterKm, exitKm: t.w.exitKm,
          departSec: t.departSec, arriveSec: t.arriveSec,
          distanceKm: t.w.exitKm - t.w.enterKm + r.approachKm + r.egressKm,
          togetherMinutes: share.get(r.id)!, conflict: null,
        };
    }
    // PARK — minimal, anchored to the runner's OWN tightest hard floor in space (fixed enter pin >
    // fixed exit pin > route origin; display only) and time (max(t0, earliest)) — never a fabricated 0,
    // borrowed clock, or wrapped negative. A named conflict, or a squeezed-out window with no flock near.
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
