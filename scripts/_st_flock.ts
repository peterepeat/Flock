// Boids flocking sim — OUTCOME test.
// Category: flock — the landing-hero flocking behaviour (no DOM, no app model).
//   npx tsx scripts/_st_flock.ts
//
// We can't "see" the animation, so assert the BEHAVIOUR that makes it flocking:
// from a random scatter the agents (a) stay finite + in bounds, (b) keep their
// per-boid speed limits, (c) come together (nearest-neighbour distance shrinks,
// connectivity rises), (d) don't pile up (separation keeps a floor distance), and
// (e) genuinely fly at different speeds.

import { createBoids, defaultParams, stepFlock, type Boid, type FlockParams } from "../src/lib/flockSim";
import { ok, suite, section, finish } from "./_st_harness";

// Deterministic RNG (mulberry32) so the run is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 960, H = 600, N = 26;

function nnStats(boids: Boid[]): { medianNN: number; connectivity: number; minPair: number; perception: number } {
  const nn: number[] = [];
  let minPair = Infinity;
  let withNeighbour = 0;
  const PER = 120;
  for (let i = 0; i < boids.length; i++) {
    let best = Infinity;
    for (let j = 0; j < boids.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(boids[i].x - boids[j].x, boids[i].y - boids[j].y);
      best = Math.min(best, d);
      if (i < j) minPair = Math.min(minPair, d);
    }
    nn.push(best);
    if (best <= PER) withNeighbour++;
  }
  nn.sort((a, b) => a - b);
  return { medianNN: nn[Math.floor(nn.length / 2)], connectivity: withNeighbour / boids.length, minPair, perception: PER };
}

function main() {
  suite("flock");
  const rng = mulberry32(12345);
  const boids = createBoids(N, W, H, rng);
  const params: FlockParams = { ...defaultParams(W, H), perception: 120 };

  section("0. setup");
  ok(boids.length === N, `spawned ${N} boids`);
  const speeds = boids.map((b) => b.maxSpeed);
  ok(Math.max(...speeds) - Math.min(...speeds) > 25, `boids fly at DIFFERENT speeds (range ${(Math.max(...speeds) - Math.min(...speeds)).toFixed(0)} px/s)`);

  const start = nnStats(boids);

  // Run ~15s of sim at 60fps.
  const dt = 1 / 60;
  let anyNaN = false, everOutOfBounds = false;
  for (let s = 0; s < 900; s++) {
    stepFlock(boids, dt, W, H, params);
    for (const b of boids) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.vx) || !Number.isFinite(b.vy)) anyNaN = true;
      if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) everOutOfBounds = true;
    }
  }
  const end = nnStats(boids);

  section("1. numerically stable + bounded");
  ok(!anyNaN, "no NaN/Infinity in any boid over the whole run");
  ok(!everOutOfBounds, "every boid stayed inside the field the whole run");

  section("2. speed limits respected (each boid within its own band)");
  const speedOk = boids.every((b) => {
    const sp = Math.hypot(b.vx, b.vy);
    return sp <= b.maxSpeed * 1.02 && sp >= b.maxSpeed * 0.45 * 0.98;
  });
  ok(speedOk, "every boid moves within [0.45·max, max] of its own top speed");

  section("3. they FLOCK (cohesion) — without piling up (separation)");
  ok(end.connectivity > start.connectivity, `connectivity rose ${(start.connectivity * 100).toFixed(0)}% → ${(end.connectivity * 100).toFixed(0)}%`);
  ok(end.connectivity >= 0.8, `most boids have a neighbour at the end (${(end.connectivity * 100).toFixed(0)}%)`);
  ok(end.medianNN < start.medianNN, `they came together (median nearest-neighbour ${start.medianNN.toFixed(0)} → ${end.medianNN.toFixed(0)} px)`);
  ok(end.minPair > params.separation * 0.3, `no heavy overlap — closest pair ${end.minPair.toFixed(0)}px > ${(params.separation * 0.3).toFixed(0)}px`);

  section("4. the avoid region is skirted");
  const avoid = { cx: W / 2, cy: H / 2, rx: 300, ry: 150, force: 320 };
  const boids2 = createBoids(N, W, H, mulberry32(777));
  const params2: FlockParams = { ...defaultParams(W, H), perception: 120, avoid };
  for (let s = 0; s < 900; s++) stepFlock(boids2, dt, W, H, params2);
  const inside = boids2.filter((b) => ((b.x - avoid.cx) / avoid.rx) ** 2 + ((b.y - avoid.cy) / avoid.ry) ** 2 < 0.7).length;
  ok(inside <= 2, `the headline ellipse stays clear (${inside}/${N} boids deep inside)`);

  finish();
}

main();
