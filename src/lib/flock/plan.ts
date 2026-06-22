// ---------------------------------------------------------------------------
// Flock — the planner. Pure and ORS-free: given a shared route, the runners' hard
// constraints, and the flock's departure time, it places each runner's participation
// window to maximise summed pairwise co-present minutes, runs the one flock clock
// (slowest-present pace + dwell), and reads off the company blocks.
//
// Route construction (ORS) and projection to the app's CalcResult live elsewhere; this
// is the heart, kept pure so it is deterministically testable.
// ---------------------------------------------------------------------------

import type { Block, Plan, Route, RunInput, Runner, RunnerPlan, Warning } from "./model";

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
      // trim proportionally to the overshoot
      const over = arrive - r.latestSec;
      const newExit = Math.max(w.enterKm, w.exitKm - over / r.pace);
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

// --- warnings: explain every deviation; flag the lonely --------------------
function buildWarnings(runners: Runner[], plans: RunnerPlan[], routeKm: number): Warning[] {
  const out: Warning[] = [];
  const byId = new Map(runners.map((r) => [r.id, r]));
  for (const p of plans) {
    const r = byId.get(p.id)!;
    const covered = p.exitKm - p.enterKm;
    const short = covered < routeKm - 0.3;
    // The lonely warning ("re-pin to join") only applies to a runner whose OWN window is
    // short — never to a full-route runner whose together-time merely dipped because ANOTHER
    // runner collapsed to a degenerate point. A full-coverage runner gets no warning.
    if (short && p.togetherMinutes < 1 && plans.length > 1) {
      out.push({ id: p.id, message: "You barely overlap with anyone — pin your start to a waypoint the flock passes to join them." });
    } else if (short) {
      const why = r.latestSec != null ? "to be done in time" : r.earliestSec != null ? "from when you can start" : r.maxDistanceKm != null ? "to stay within your distance" : "where you join/leave";
      out.push({ id: p.id, message: `You're with the flock for ${covered.toFixed(1)} of ${routeKm.toFixed(1)} km — ${why}.` });
    }
  }
  return out;
}

// --- the entry point --------------------------------------------------------
export function planRun(input: RunInput): Plan {
  const { route, runners, t0Sec } = input;
  const wins = resolveWindows(input);
  enforceEarliest(wins, route, runners, t0Sec);
  enforceDeadlines(wins, route, runners, t0Sec);
  const blocks = computeBlocks(wins, route, runners, t0Sec);

  // per-runner share of together-time
  const share = new Map(runners.map((r) => [r.id, 0]));
  for (const b of blocks) {
    if (b.members.length < 2) continue;
    const min = (b.endSec - b.startSec) / 60;
    for (const id of b.members) share.set(id, share.get(id)! + min);
  }

  const plans: RunnerPlan[] = runners.map((r) => {
    const w = wins.get(r.id)!;
    // Timing reads the runner's ACTUAL span in the built schedule: they leave home so as to
    // reach their first block exactly when it starts (minus the approach run from a manual pin),
    // and arrive home after their last block ends (plus the egress run). Reading the span — not
    // arrivalAt(km) — is what makes an opening dwell, a finish-at-a-café reunion, and a
    // deadline-trimmed dwell all time correctly. Fallback for a degenerate zero-span window.
    const span = runnerSpan(blocks, r.id);
    const first = span?.first ?? arrivalAt(blocks, w.enterKm);
    const last = span?.last ?? arrivalAt(blocks, w.exitKm);
    return {
      id: r.id,
      enterKm: w.enterKm,
      exitKm: w.exitKm,
      departSec: first - r.approachKm * r.pace,
      arriveSec: last + r.egressKm * r.pace,
      distanceKm: w.exitKm - w.enterKm + r.approachKm + r.egressKm,
      togetherMinutes: share.get(r.id)!,
    };
  });

  return {
    blocks,
    runners: plans,
    togetherMinutes: togetherMinutes(blocks),
    warnings: buildWarnings(runners, plans, route.totalKm),
  };
}
