// ---------------------------------------------------------------------------
// A tiny boids flocking simulation (Reynolds 1987): each agent steers by three
// local rules — separation (don't crowd), alignment (match heading), cohesion
// (steer toward the group) — plus soft forces to stay in the field and skirt an
// "avoid" region (the headline). Agents fly at DIFFERENT speeds, so the flock has
// natural variation. Pure + DOM-free so the behaviour can be unit-tested headless.
//
// Forces are accelerations (px/s²); integration is dt-scaled, so the motion is
// framerate-independent.
// ---------------------------------------------------------------------------

export interface Boid {
  x: number;
  y: number;
  vx: number;
  vy: number;
  maxSpeed: number; // px/s — varied per boid
}

export interface AvoidEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  force: number;
}

export interface FlockParams {
  perception: number; // neighbour radius (px)
  separation: number; // crowding radius (px)
  cohesion: number; // weight (accel)
  alignment: number;
  separationW: number;
  maxForce: number; // cap on total steering accel
  edgeMargin: number;
  edgeForce: number;
  avoid: AvoidEllipse | null;
}

export function defaultParams(W: number, H: number): FlockParams {
  return {
    perception: Math.max(90, Math.min(150, W * 0.12)),
    separation: 56,
    cohesion: 46,
    alignment: 75,
    separationW: 178,
    maxForce: 220,
    edgeMargin: Math.max(48, Math.min(120, W * 0.08)),
    edgeForce: 300,
    avoid: null,
    // caller fills `avoid` from the live text box.
  };
}

const cap = (vx: number, vy: number, max: number): [number, number] => {
  const m = Math.hypot(vx, vy);
  return m > max && m > 0 ? [(vx / m) * max, (vy / m) * max] : [vx, vy];
};

/** Spawn `n` boids scattered across the field, each with a random heading and a
 *  varied top speed. `rng` is injectable for deterministic tests. */
export function createBoids(n: number, W: number, H: number, rng: () => number = Math.random): Boid[] {
  return Array.from({ length: n }, () => {
    const a = rng() * Math.PI * 2;
    const maxSpeed = 40 + rng() * 58; // ~40–98 px/s — different paces
    const sp = maxSpeed * 0.7;
    return { x: rng() * W, y: rng() * H, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, maxSpeed };
  });
}

/** Advance the flock by `dt` seconds, in place. Accelerations are computed from a
 *  snapshot (all read, then all integrated) so no boid sees a half-updated frame. */
export function stepFlock(boids: Boid[], dt: number, W: number, H: number, p: FlockParams): void {
  const n = boids.length;
  const per2 = p.perception * p.perception;
  const sep2 = p.separation * p.separation;
  const ax = new Array<number>(n).fill(0);
  const ay = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const b = boids[i];
    let cx = 0, cy = 0, avx = 0, avy = 0, sx = 0, sy = 0, near = 0, crowd = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const t = boids[j];
      const dx = t.x - b.x, dy = t.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > per2 || d2 === 0) continue;
      near++;
      cx += t.x; cy += t.y;
      avx += t.vx; avy += t.vy;
      if (d2 < sep2) {
        const d = Math.sqrt(d2);
        sx -= dx / d; // push away, weighted toward closer boids
        sy -= dy / d;
        crowd++;
      }
    }

    let fx = 0, fy = 0;
    if (near > 0) {
      // cohesion → unit step toward the neighbours' centre
      const tcx = cx / near - b.x, tcy = cy / near - b.y;
      const cm = Math.hypot(tcx, tcy) || 1;
      fx += (tcx / cm) * p.cohesion;
      fy += (tcy / cm) * p.cohesion;
      // alignment → match the neighbours' average heading
      const am = Math.hypot(avx, avy) || 1;
      fx += (avx / am) * p.alignment;
      fy += (avy / am) * p.alignment;
    }
    if (crowd > 0) {
      const sm = Math.hypot(sx, sy) || 1;
      fx += (sx / sm) * p.separationW;
      fy += (sy / sm) * p.separationW;
    }

    // Soft walls: ramp up a turn-back force inside the margin.
    if (b.x < p.edgeMargin) fx += p.edgeForce * (1 - b.x / p.edgeMargin);
    else if (b.x > W - p.edgeMargin) fx -= p.edgeForce * (1 - (W - b.x) / p.edgeMargin);
    if (b.y < p.edgeMargin) fy += p.edgeForce * (1 - b.y / p.edgeMargin);
    else if (b.y > H - p.edgeMargin) fy -= p.edgeForce * (1 - (H - b.y) / p.edgeMargin);

    // Skirt the headline: a firm outward push anywhere inside the ellipse, easing
    // off through a small buffer just outside, so the copy stays cleanly clear.
    if (p.avoid) {
      const nx = (b.x - p.avoid.cx) / p.avoid.rx;
      const ny = (b.y - p.avoid.cy) / p.avoid.ry;
      const e2 = nx * nx + ny * ny;
      if (e2 < 1.5) {
        const dx = b.x - p.avoid.cx, dy = b.y - p.avoid.cy;
        const d = Math.hypot(dx, dy) || 1;
        const s = e2 < 1 ? p.avoid.force : p.avoid.force * ((1.5 - e2) / 0.5);
        fx += (dx / d) * s;
        fy += (dy / d) * s;
      }
    }

    [ax[i], ay[i]] = cap(fx, fy, p.maxForce);
  }

  for (let i = 0; i < n; i++) {
    const b = boids[i];
    b.vx += ax[i] * dt;
    b.vy += ay[i] * dt;
    [b.vx, b.vy] = cap(b.vx, b.vy, b.maxSpeed);
    // keep a minimum cruising speed so nobody stalls
    const min = b.maxSpeed * 0.45;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < min) {
      if (sp > 1e-6) { b.vx = (b.vx / sp) * min; b.vy = (b.vy / sp) * min; }
      else b.vx = min;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // hard safety clamp (the soft walls do the real work)
    b.x = Math.max(6, Math.min(W - 6, b.x));
    b.y = Math.max(6, Math.min(H - 6, b.y));
  }
}
