# Flock — the build roadmap

> **✅ BUILT & SHIPPED — 2026-06-22.** This roadmap is complete. The social-first engine lives in
> `src/lib/flock/` (`model` · `plan` · `route` · `project` · `index`); the legacy
> `routeEngine.ts` / `flockRoute.ts` / `insight.ts` were deleted and it shipped to production on
> `main`. Tests: `scripts/_st_*` (850+ assertions) + `scripts/_flock_*_test.ts`. The build plan below
> is kept as the historical record of *what was built and why*. **For the current state and the open
> frontier, jump to [What's next](#whats-next) at the bottom.**

How it was built, from [`MODEL.md`](./MODEL.md) — not from the prior engine (that engine is gone, reused
only as a parts quarry: the ORS client and geo math). The roadmap was adversarially audited for legacy
encumbrance; the doctrines below were the load-bearing corrections.

---

## Three doctrines (the anti-encumbrance invariants)

**1 · Legacy is a quarry and a sink — never a gate, oracle, or spec.**
We reuse the old engine's *leaf* assets (routing client, geo math) and we *project down* to its render
types at the very end. We never assert "correct = reproduces the old output." The old `CalcResult` is
a one-way **sink** (`project.ts` fills it for the UI); it is never read back as a target.

**2 · Own-pace is the sole welfare axis, from the first line of welfare code.**
Probe 1 proved `systemTM = wall-minutes × pairs` is a *different ranking*, not a scaling, of
own-pace value (a fast runner's credit moved +66.7% with zero geometry change). Therefore you
**cannot** byte-match the legacy golden *and* adopt own-pace — the attempt silently keeps wall-minutes
as the spec for as long as parity is demanded. So: wall-minutes never enters the new core. Parity is
**split** — a *geometry* layer (routes + shared-segment polylines, degenerate cases only, a one-way
regression smoke-test) and a *welfare* layer (own-pace, which **deliberately diverges** from legacy
and has its own fresh golden). Geometry parity guards the degenerate reads; it never touches the
objective.

**3 · WEAVE is one operation; topology is one search; the legacy "tiers" are reads, not phases.**
Natural and forced weaves are two *cost regimes* of the same `WEAVE` call (free when ρ is already on
both shortest paths; value-gated when ρ is synthesised off-path). The rosette is a `WEAVE` to a
runner's own home with a cyclic σ — a *test case*, not a module. Formation/dispersal are one block's
two time-ends. The dendrogram is one recursive `WEAVE` search. Corridor is a *geometry* constraint on
σ (thread pinned waypoints in order), orthogonal to topology. Building "natural → forced → rosette →
corridor" as separate phases re-grows the legacy patch tier under new names — don't.

---

## Build strategy — greenfield alongside, cut over at one seam

New module tree `src/lib/flock/`, built on the atom and `WEAVE`. **Not** an in-place morph: morphing
`routeEngine.ts` forces the new code to inherit the 1-D backbone / `[enterKm,exitKm]` / single-clock /
wall-minutes decomposition the model exists to undo.

The deployed app keeps running on the **legacy engine untouched** for the entire build — the new
module is dormant greenfield until it matches-or-beats on the *own-pace* metric. This removes any
pressure to ship-the-new-thing early (the pressure that pulls the encumbrance back in), so we build
**de-risk-first**: the scariest, most-novel piece (the admissibility fixpoint + the space×time atom)
goes first, welfare strictly last, and the already-settled forced-weave risk (Probe 2) does not get a
hero milestone.

**The cutover is a single call-site swap.** Exactly one consumer reaches the engine:
`src/app/api/routes/calculate/route.ts` → `calculateRoutes(session)`. Phase 5 flips a flag there and
deletes the superseded code. Persistence, the API contract, and the UI are untouched throughout.

---

## Pre-decided (so a cold session doesn't stall by hour two)

These were "open" in the draft but sit on the phase-0 critical path; decide them now, not mid-build:

- **`TimingSolver` is a pure function** `(blocks, constraints) → start-instants | INFEASIBLE`, called
  *inside* `admit`'s cycle. The single global anchor is merely its **first implementation**; the
  temporal constraint network (concurrent sub-flocks) is a later implementation of the same interface
  — so phase 0 does not foreclose it.
- **`admit` and `welfare` are separate modules.** Welfare consumes the realised block vector *after*
  the fixpoint converges. The model says welfare is strictly clean-last; folding it into `admit`
  re-creates the leaky coupling Probe 1 diagnosed.
- **A non-convergent fixpoint DECLINES the weave** (safe). `admit` returns `INADMISSIBLE` on hitting
  the iteration cap; it never ships a best-effort half-solved block.

---

## Phases

### Phase 0 — The atom + the admissibility fixpoint (the irreducible core, first)
- **Builds.** `flock/types.ts` — `Block{ S:Set<runnerId>, σ:TimedPolyline ({lat,lng,tAbs}[]), π }`,
  `Plan = Block[]` (a forest; the atom permits a DAG, the type does not forbid it), and the
  `TimingSolver` interface. `flock/admit.ts` — the four-cycle fixpoint
  (re-pace → re-anchor via `TimingSolver` → envelope-clip → re-coefficient the Fermat objective) to a
  bounded fixpoint, declining on non-convergence.
- **De-risks.** The two genuinely novel unknowns: (a) is the space×time atom *necessary* and
  *sufficient*; (b) does the supermodular timing↔feasibility↔geometry cycle converge.
- **Test gate.** Three micro-fixtures, **zero ORS, zero adapter, zero legacy import**: a **2-clock
  case the single global anchor provably cannot satisfy** (proves the atom beats one clock — and
  forbids the single-clock-as-spec leak); a **floor-break** (an incumbent's value drops below their
  floor → the weave declines); a **termination** assertion (iteration cap → `INADMISSIBLE`).
- **Designed-for-deferred.** The `TimingSolver` seam keeps the constraint-network future open; σ
  carries per-vertex `tAbs` so asymmetric finish≠home and true temporal non-coincidence are
  representable from day one.
- **Exit.** The fixpoint converges on the fixtures; the 2-clock case fails under a single anchor and
  passes under a per-block one. `tsc` clean.

### Phase 1 — Own-pace welfare (the objective, clean-last)
- **Builds.** `flock/welfare.ts` — `value_i(B) = shared_distance(B) × pace_i` (own-pace; equivalently
  pace-neutral shared-km), aggregated by `W` (sum / leximin) over the realised vector *after* `admit`.
  Wall-minutes never appears.
- **De-risks.** That the model's objective is implementable as a clean-last functional and is
  companion-pace-neutral.
- **Test gate.** `scripts/_welfare_probe.ts` (exists) — credit is flat as a companion slows. A small
  fresh welfare golden (own-pace vectors), *not* a re-base of the wall-minutes snapshot.
- **Exit.** Welfare is a pure read of the realised plan; the probe is green; no wall-minutes symbol in
  `flock/`.

### Phase 2 — The projection sink + geometry-parity smoke-test (one-way)
- **Builds.** `flock/project.ts` — projects the block forest **down** to the existing
  `{ computedRoutes, sharedSegments, flockRoute, waypointEtas }` the UI renders. A sink; it never reads
  legacy output back.
- **De-risks.** The render seam and the degenerate reads — before any real weave exists.
- **Test gate.** The **split parity harness** (write its spec before this phase — see gaps): *layer A*
  geometry parity (routes + shared-segment polylines deep-equal legacy on solo/star fixtures only, a
  one-way smoke-test); *layer B* welfare (own-pace, expected to diverge). **Definition of done =
  every row of `MODEL.md`'s degenerate-reads table reproduced** through `project.ts`.
- **Exit.** A forest of singleton blocks renders identically (geometry) to a legacy solo plan; welfare
  differs by design.

### Phase 3 — WEAVE (the one generating operation)
- **Builds.** `flock/weave.ts` — one `WEAVE(end_a, end_b, ρ)` with two cost regimes (natural = ρ on
  both shortest paths, free; forced = ρ off-path, value-gated). `SPLIT = WEAVE` reverse-time. Forced
  affordability = **crow orders the candidate axis, ORS monotone binary-search at commit** (Probe 2),
  never crow-as-gate.
- **De-risks.** That natural and forced are genuinely one operation, and that forced weaves commit in
  `O(log k)` ORS, not a search.
- **Test gate.** 2-runner natural weave renders a shared block; forced via `scripts/_rank_probe.ts`
  (O(log k) frontier-search); **rosette as a `WEAVE`-to-own-home case** via `scripts/_nest_probe.ts`
  (the constrained runner becomes a full member) — a test, not a module.
- **Exit.** All three are cases of the *one* `weave.ts`; no separate forced/rosette code paths.

### Phase 4 — Topology: the dendrogram search (recurse WEAVE)
- **Builds.** `flock/agglomerate.ts` — recurse `WEAVE` bottom-up over runner-subsets = the convergence
  dendrogram. N=2–5 brute-forced over the candidate set; large-N = explicit heuristic
  natural-weave-first agglomeration (Wall 3, logged as heuristic, not silently capped). **Corridor is
  a separate geometry concern**: a constraint that the trunk block's σ thread pinned waypoints in
  order — built as a σ-axis constraint, not a topology mode.
- **De-risks.** The discrete search and the heuristic tail; the corridor geometry kept off the topology
  path.
- **Test gate.** Unit-test the dendrogram against `flocksim_work/treevalue.py` + `roadsim.py` (same
  inputs → same tree + together-value); corridor against the ordered-waypoint fixtures.
- **Exit.** The full scenario suite (`scripts/scenarios.sh`) passes on the new engine on the own-pace
  metric; corridor and agglomeration share no code path.

### Phase 5 — Cutover + delete
- **Builds.** A flag at `src/app/api/routes/calculate/route.ts` selecting `flock/` vs legacy. Flip when
  the new engine matches-or-beats on the own-pace metric and geometry parity holds on the degenerate
  fixtures.
- **Test gate.** Full `scenarios.sh` + the split harness green on the new engine.
- **Exit.** Flag flipped; **`routeEngine.ts` core and `flockRoute.ts` patch-tier deleted**; the reused
  leaf assets remain. The 242 branches are gone.

---

## Legacy disposition (explicit)

- **Superseded + deleted at cutover.** `routeEngine.ts` (the optimizer / flock-clock / accounting
  pipeline) and `flockRoute.ts`'s patch tier (F/D/forced/rosette/corridor/grow as separate builders).
- **Reused as leaf assets** (called, never inherited from): `ors.ts` (`getRoute`/`getRoundTrip`/
  `RouteError`), `geo.ts` (`distanceMeters`/`bearingRad`/`destinationPoint`/`closestPointOnSegment`/
  `despurLoop`), `scanMeetingPoint`'s candidate-axis **geometry** (re-homed under the monotone-search
  contract, not its validate-or-decline contract), the `types.ts` domain types, and the render shapes
  as the `project.ts` sink target.
- **Replaced.** The monolithic `scripts/golden.ts` byte-equality → the split harness (geometry layer +
  own-pace welfare layer). The probes (`_welfare_probe`, `_rank_probe`, `_nest_probe`) carry forward as
  phase gates.

## Deferred — designed for, not foreclosed

- **Concurrent disjoint sub-flocks at independent paces** (the `treevalue.py` +71% clustered win):
  a later `TimingSolver` implementation = a temporal constraint network over block start-instants. The
  interface exists from phase 0; this is an implementation, not a rewrite.
- **Non-laminar co-presence** (relay / rejoin): `Plan` is a forest now; the `Block` atom permits the
  DAG and the type does not forbid it.
- **Asymmetric finish≠home**: σ carries time from phase 0; two co-solved weave-trees share one ledger
  (F≡D only when finish=home) is expressible without new atom surgery.

## Open for session zero (genuinely deferrable)

- Flag mechanism: env var vs per-session field.
- `Plan` as explicit DAG vs forest-for-now (start forest; the atom keeps the door open).
- `W`'s exact shape (sum vs leximin vs blend) — a welfare-axis choice, settled empirically in phase 1.

## Session-zero readiness checklist

- [ ] `MODEL.md` read — object, operation, composition, and the **degenerate-reads table** (the
      `project.ts` definition-of-done).
- [ ] This roadmap read; the three doctrines internalised.
- [ ] The three phase-0-critical decisions taken as written (TimingSolver pure fn; admit/welfare
      separate; non-convergence declines).
- [ ] **Split parity harness spec written** (geometry layer vs welfare layer) — the one doc to author
      before phase 2; the highest-priority gap.
- [ ] Leaf assets + the single cutover seam located (`ors.ts`, `geo.ts`, `scanMeetingPoint`,
      `src/app/api/routes/calculate/route.ts`, the three probes).
- [ ] Internalised: legacy is a quarry and a sink, never a gate.

## First task (hour one, concrete)

Create `src/lib/flock/types.ts` (`Block`, `Plan`, `TimingSolver`), then `flock/admit.ts` (the four-cycle
fixpoint, declining on non-convergence), then the micro-fixture unit test: a 2-clock case the single
anchor cannot satisfy, a floor-break, a termination assertion. **Zero ORS, zero adapter; do not touch
`routeEngine.ts`.** Everything phase 0 needs is in `MODEL.md`.

---

## What's next

The product is live and correct; nothing below is blocking.

**Resolved 2026-06-22 (this session):**

1. ~~**Concurrent pace-cohorts at independent paces**~~ — **investigated and DELIBERATELY NOT
   BUILT.** A 6-lens adversarial refutation panel + direct engine probes settled it: the ~+71%
   sim win was an artifact of the *old pace-tax* (penalising dragging fast runners slow), which the
   social-first rebuild deliberately dropped. Under the current pure co-presence objective,
   independently-timed pace-cohorts are *strictly dominated* by the single clock (cross-pace moving
   co-presence is measure-zero; cohorts forfeit it and recover only dwell-interval overlap ≤ what the
   single clock already grants). A temporal constraint network would be unjustified complexity. **The
   real win the panel surfaced is simpler and more general — FINISH-AT-REUNION:** a *dwell stop is a
   reunion; everyone whose window includes it shares it — passing through OR finishing there.* Shipped:
   a finisher-at-a-café now banks the dwell (was a defect — excluded by a strict `exitKm > at`); a
   deadline-bound runner is steered to *finish at* a reachable café and park for the reunion instead of
   being evicted before it (the one shape where the panel found cohorts beat the single clock — now
   captured *without* per-cohort clocks). Per-runner timing now reads the runner's actual block span,
   not `arrivalAt(km)`. See memory `flock-cohorts-verdict`. The *one* deferred residual (rare): a runner
   who can't reach a café at slowest pace within deadline but could at their *own* pace (running ahead) —
   the only case that would need a per-runner approach clock; documented, not built.
2. ~~**Commuter / point-to-point (finish ≠ home, asymmetric)**~~ — scores cleanly now. A latent
   connector bug (approach+egress were summed and applied to *both* departure and arrival) was fixed by
   splitting `connectorKm` into `approachKm` (shifts departure) and `egressKm` (shifts arrival).
4. ~~**Cosmetic: `departureTime` after an opening dwell**~~ — fixed by span-based per-runner timing.

**Remaining:**

3. **UI polish not yet browser-driven** — the manual-pin address-search flow, the GPX import path, the
   mobile bottom-sheet. **Per-pair affinity** ("I came to run with Sam") was deliberately left
   *pluggable* in the objective but not wired — add a weight to the pairwise sum if wanted (only if a
   real product need appears — it's complexity otherwise).

The conceptual bedrock is in [`MODEL.md`](./MODEL.md); the regression guard is `scripts/_st_*` (run any
with `npx tsx scripts/_st_<name>.ts`). Dev browser checks without a live ORS key: `scripts/_seed_dev.ts`.
