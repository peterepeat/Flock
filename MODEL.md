# Flock — the model

The conceptual core the route engine is an instance of. Written after a first-principles
re-derivation (six independent framings, adversarially broken, synthesised and elegance-audited)
plus two live make-or-break probes. The current `routeEngine.ts` / `flockRoute.ts` are one
projection of this model; everything they do is a degenerate read of it. This doc is the thing to
build against — not a description of today's code, but the object today's code approximates.

> **One object (the company block), one operation (WEAVE), one law (an admissibility fixpoint).**
> A flock plan is a *co-presence lamination* of runner world-lines over the road-graph × wall-clock
> product. Every primitive — backbone interval, flock clock, formation/dispersal, forced meeting,
> rosette, corridor, opportunistic overlap, solo fill, fairness — is a read of *which blocks exist
> and where their rendezvous sit*. The 1-D backbone is this lamination flattened onto one
> totally-ordered arc with one global clock.

---

## The problem

N people, each at a location, each wanting to run — a distance, within pace/time/budget limits, and
ideally **together** with as much of the group, for as long as possible. Optionally the group
nominates shared destinations (cafés/waypoints). Output: a route + schedule per person. The thing we
maximise is *shared running*, fairly, subject to every runner's hard constraints.

## The object — the COMPANY BLOCK

A block `B = (S, σ, π)`:

- `S ⊆ runners` — who is in it.
- `σ ⊆ G × ℝ_t` — a connected segment in the **road-graph × wall-clock product** (a polyline *with
  timestamps*, not arc-length). **Time is a coordinate of the atom, not a downstream label:** two
  runners on the same street at different instants share *nothing*.
- `π = max-pace over S on σ` — the segment runs at its slowest present member's pace.

A runner's plan is the time-ordered chain of blocks they appear in. Singletons (`|S| = 1`) are
first-class — solo, strand, warm-up, cool-down, connector are all one-runner blocks, never special
cases. The whole plan is a **lamination**: bundles of runner world-lines that fuse on shared
space-time segments and peel at rendezvous.

> Why space×time and not arc-length: it is the single change that distinguishes *"ran the same
> street"* from *"ran together"* structurally, rather than by the accident of one global clock. The
> current `systemTM` only works because the single timeline forces co-location to imply co-timing.

## The operation — WEAVE (and SPLIT = WEAVE in reverse time)

`WEAVE(end_a, end_b, ρ)`: bind two block-ends at a shared space-time rendezvous `ρ ∈ G × ℝ_t`, route
each side's connector to `ρ`, and emit a block with `S = S_a ∪ S_b`, `σ` = the shared segment
onward, `π = max(π_a, π_b)` — charging each joiner its connector *length and time* (`ρ` pins a clock,
not just a place). **SPLIT is WEAVE with the time coordinate reversed** (egress). Formation `F` and
dispersal `D` are literally one block's two time-ends sharing one ledger — which is *why* the joint
F/D co-solve was inevitable, not a patch.

- **Natural weave** — `ρ` already lies on both shortest paths at a compatible time: zero connector,
  read off already-fetched routes, free.
- **Forced weave** — `ρ` synthesised off-path at positive connector cost, accepted only if it clears
  the value test.

Recursing WEAVE bottom-up over runner-subsets emits the convergence dendrogram. Zero weaves = N solo
chains; one weave over all leaves = the star; weaving a leaf's two ends to its own home = the rosette.

## The composition — a constrained fixpoint, not a pipeline

Five concerns. Four would compose one-way; the fifth (timing) is a feedback edge that reaches
further than a clean DAG admits.

1. **Geometry** — runners → road polylines + rendezvous placement (a weighted-Fermat/Steiner point
   per node). The *sole* distance-oracle consumer.
2. **Topology** — which subsets weave, in what nesting (the discrete dendrogram search).
3. **Timing** — `π = max(present)` *and* the global departure anchor pinning every rendezvous
   instant — a **fixpoint** (`anchorT0` is a global `Math.max`; `enforceConstraints` iterates), not a
   pass.
4. **Feasibility** — each runner's envelope (cap / deadline / pace / budget) clips admissible blocks.
5. **Welfare** — the aggregator `W` (sum / pairwise / leximin) over the realised vector. **Strictly
   last.**

```
value(plan) = W( score_blocks( anchor-and-pace( WEAVE*-admissible( route(runners) ) ) ) )
```

`WEAVE*` is gated by **one admissibility predicate** that folds timing + feasibility into topology:
*a weave is admissible iff — after re-pacing the bound segment to its slowest member, re-solving the
global anchor, and propagating the envelope fixpoint — every member's deadline/cap holds and no
incumbent's co-present value drops below their floor.* This predicate is the only back-edge, and it
is a **cycle of four**: the slowest-present pace re-prices the segment → shifts the global anchor
(non-local) → can break a non-adjacent runner's deadline → makes the weave inadmissible → and,
because minutes = length / slowest-pace, also re-coefficients the rendezvous's Fermat objective. So
the rendezvous is solved *inside* the fixpoint, per candidate. Only **welfare** is genuinely clean-last.

## The objective — shared-distance-at-own-pace (NOT wall-minutes) · validated by Probe 1

Today's welfare base unit, `systemTM = Σ wall-minutes × pairs` (`routeEngine.ts:1469`), **rewards
slow-joins**: because a shared leg runs at `max(present)` pace (`:653`), a slower companion inflates
the leg's wall-minutes, and the engine counts that inflation as *more togetherness* for everyone —
including the fast runners it is dragging.

`scripts/_welfare_probe.ts` demonstrates this on the real engine under deterministic fake-ORS: with
the geometry held fixed (same homes, same 3.93 km shared), slowing a companion from 6:00→10:00 /km
raises the **fast, unchanged runner's** togetherness credit by **+66.7%** for zero extra sharing.

The fix the relational floor implies: a runner's value from company depends only on **their own pace
and the shared distance**, never on a companion's pace.

```
value_i(B) = (shared distance of B) × pace_i          // own-pace minutes; companion-pace-neutral
           — equivalently, shared kilometres (fully pace-neutral)
```

Both variants are flat as a companion slows (probe-confirmed). The two proposed units coincide:
"minutes minus the pace-gap penalty" reduces to own-pace shared-minutes.

## Forced weaves — crow orders, ORS commits (a monotone frontier-search) · validated by Probe 2

The whole ORS-cost quarantine rests on being able to choose a forced-weave rendezvous without pricing
every candidate with a real route (which would be a search that busts the ~40 req/min limit at N≥4).
`scripts/_rank_probe.ts` settles how, against live ORS at 32° and 103° origin spread:

- **Crow ranks candidates exactly as ORS does** — Spearman `ρ(shared) = ρ(detour) = 1.00` at *both*
  spreads (the wide-angle case the adversaries feared is fine).
- **Crow must NOT be the affordability *gate*** — its detour bias is not one-signed (optimistic
  ~1.8× at 32°, pessimistic ~0.78× at 103°), because `ROAD_FACTOR` cancels in raw distance but not in
  the *difference* that is the detour.
- **The real frontier is monotone** — shared-value *and* detour both rise as `ρ` slides back from the
  café. So "farthest-back `ρ` every member can afford" is a 1-D monotone threshold.

> **Rule:** crow seeds and *orders* the candidate axis (cheap, in-memory); ORS decides *affordability*
> at commit via a **monotone binary search** down the axis — `O(log k)` commit-checks per weave,
> independent of crow's calibration; worst case a linear ORS walk down the crow-ordered axis,
> `O(candidates)`, never `O(candidates × N)`. The current `scanMeetingPoint → applyJointForced`
> *validate-or-decline* becomes a short monotone *frontier-search*.

## Every primitive is a degenerate read

| Today | Degenerate read of the block / weave |
|---|---|
| 1-D backbone + `[enterKm, exitKm]` interval | the lamination flattened onto one ordered arc; a contiguous block-chain *is* an interval |
| flock clock `paceSec = max(present)` (`:653`) | `π_B` read leg-by-leg; a `Leg{lo,hi,present,pace}` **is** a block |
| star / single rendezvous | the dendrogram with no interior weave (depth-1) |
| formation `F` / dispersal `D` | one block's two time-ends sharing one ledger |
| forced meeting point `P` | a WEAVE whose `ρ` is a value-gated off-path Steiner point |
| rosette nested return-to-base laps | a WEAVE whose `ρ` is the runner's own home, `σ` a cycle |
| ordered corridor (≥2 waypoints) | the geometry axis constraining the trunk block's `σ` to thread pinned nodes in order |
| grow-loop / size-to-2nd-longest | the feasibility clip choosing the trunk block's `σ`-length |
| solo warm-up / cool-down / strand / connectors | singleton blocks (`|S|=1`) — the base case of WEAVE |
| `opportunisticOverlap` | a natural weave the backbone projection *hid* — in the lamination it was never separate |
| priced windows / marginal-value certificate | the Lagrangian dual on the feasibility envelope |
| 0.85 gate / fairness sizing / bias / rescue | the welfare aggregator `W` tilting sum→leximin over the same lamination |
| `anchorT0` + `enforceConstraints` (`:925-947`) | the timing↔feasibility fixpoint resolving |
| crow×1.3 vs ORS reconciliation | the two-tier oracle: cheap surrogate to *order*, real road to *commit* |

## The one irreducible difficulty — the admissibility fixpoint

All hardness lives in *scoring whether to weave a subset*, given that the slowest-present pace (1)
re-prices the bound segment, (2) re-solves the **global** anchor (a slow leaf drags the whole flock's
launch and can break a non-adjacent runner's deadline), (3) re-coefficients each rendezvous's Fermat
objective, and (4) propagates the envelope fixpoint. This is the supermodular / non-superadditive
core — adding a member can *lower* others' value; the coalition game's core can be empty; the
submodular `1−1/e` guarantee is false. The model **names and bounds** it (three walls), it does not
pretend it is cheap or local:

- **Wall 1** — welfare only re-ranks the handful of admissible laminations that survived the fixpoint.
- **Wall 2** — candidate selection is crow-ordered, ORS-committed via a monotone frontier-search:
  `O(N) + O(log k)` real routes per committed weave, never `O(candidates × N)`. *(Probe 2.)*
- **Wall 3** — at N=2–5 the candidate set is brute-forceable; at large N it is *explicitly* heuristic
  natural-weave-first agglomeration, not an exact solve.

## Honest limits (deferred, named — not solved)

- **Exact topology at large N** — NP-hard and ORS-bounded; N≥6 runs heuristic agglomeration.
- **Non-laminar co-presence** — relay/baton chains, rejoin (a runner sharing two non-adjacent spans),
  and concurrent disjoint sub-flocks at *independent* paces: the atom (`σ ∈ G×ℝ_t`) **expresses** all
  three, but the laminar WEAVE generator and the single global anchor cannot **produce** them.
  Concurrent clocks need a temporal constraint network over block start-instants — real new machinery,
  and the route to the `+71%` clustered-subgroup win (`treevalue.py`).
- **Asymmetric out ≠ return** — `finishPt ≠ home` is first-class input; `F ≡ D` by reflection holds
  only when finish = home, else two co-solved-but-distinct weave-trees share one ledger.
- **The supermodular tax itself** — a slow friend's arrival is everyone's tax; the model surfaces it,
  it cannot remove it.

The disclosed residue: the laminar generator is mildly shaped by "the last hard problem was a tree."
The object permits the DAG; the first generator commits to the dendrogram, with the rest named above.

## Evidence — the probes

```
npx tsx scripts/_nest_probe.ts      # nested far-café tier feasibility (geometry OK, estimator pessimistic)
npx tsx scripts/_welfare_probe.ts   # objective: systemTM rewards slow-joins; own-pace unit fixes it
npx tsx scripts/_rank_probe.ts      # forced-weave selection: crow orders, ORS monotone-search commits
```

`_nest_probe` and `_rank_probe` hit live ORS (`.env.local` key, paced under the rate limit);
`_welfare_probe` runs the real engine under the golden deterministic fake-ORS (no network).

## Status

Both load-bearing gates resolved favourably: the core is **correct** (the objective is the one place
today's engine inherits a leaky proxy, and the fix is derived not guessed) and **buildable** (forced
weaves are committable without an ORS blowup). The object, operation, and fixpoint-law are the frame
to commit. Sequencing the migration is a separate exercise, to be re-derived *after* adopting the
own-pace welfare unit — the structural roadmap that preceded this re-derivation assumed the leaky
wall-minutes objective and must be redone on this base.
