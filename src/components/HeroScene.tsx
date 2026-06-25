"use client";

import { useEffect, useRef } from "react";

import { createBoids, defaultParams, stepFlock } from "@/lib/flockSim";

// The landing hero: a flock of disco runners — just like the app's party dancers —
// flying free at different speeds and actually FLOCKING (separation / alignment /
// cohesion) around the headline. The boids sim is pure (src/lib/flockSim.ts); this
// just runs it on rAF and paints DOM avatars. Client-only.

const PALETTE = ["#E8855A", "#6A5AE0", "#D4A847", "#8B6FC4", "#4A8FC4", "#C44A7A"];
const DANCERS = ["🕺", "💃"];

export default function HeroScene() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let W = root.clientWidth;
    let H = root.clientHeight;
    if (!W || !H) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const rng = Math.random;

    // Flock size scales with the canvas (capped both ends).
    const N = Math.max(12, Math.min(30, Math.round(W / 52)));
    const boids = createBoids(N, W, H, rng);
    const meta = boids.map((_, i) => ({
      color: PALETTE[Math.floor(rng() * PALETTE.length)],
      size: 24 + Math.round(rng() * 13),
      glyph: DANCERS[i % DANCERS.length],
    }));

    const nodes = boids.map((_, i) => {
      const el = document.createElement("div");
      el.className = "hero-boid";
      el.style.setProperty("--c", meta[i].color);
      el.style.width = el.style.height = el.style.fontSize = `${meta[i].size}px`;
      el.innerHTML = `<span class="hero-boid__glyph">${meta[i].glyph}</span>`;
      root.appendChild(el);
      return el;
    });

    const params = defaultParams(W, H);

    // Skirt the actual headline box so the copy stays clear.
    const content = document.querySelector<HTMLElement>("[data-hero-content]");
    const measureAvoid = () => {
      if (content) {
        const cr = content.getBoundingClientRect();
        const rr = root.getBoundingClientRect();
        params.avoid = {
          cx: cr.left + cr.width / 2 - rr.left,
          cy: cr.top + cr.height / 2 - rr.top,
          rx: cr.width / 2 + 48,
          ry: cr.height / 2 + 44,
          force: 470,
        };
      } else {
        params.avoid = { cx: W / 2, cy: H * 0.47, rx: Math.min(W * 0.42, 380), ry: Math.min(H * 0.32, 230), force: 340 };
      }
    };
    measureAvoid();

    const place = () => {
      for (let i = 0; i < boids.length; i++) {
        nodes[i].style.transform = `translate(${boids[i].x - meta[i].size / 2}px, ${boids[i].y - meta[i].size / 2}px)`;
      }
    };

    // Warm the sim up so the FIRST paint is already a settled flock (headline clear),
    // not a raw scatter that visibly snaps together.
    for (let s = 0; s < (reduce ? 160 : 70); s++) stepFlock(boids, 1 / 60, W, H, params);
    place();

    let raf = 0;
    let last = 0;
    if (!reduce) {
      const tick = (now: number) => {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        last = now;
        stepFlock(boids, dt, W, H, params);
        place();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    const onResize = () => {
      W = root.clientWidth;
      H = root.clientHeight;
      params.edgeMargin = Math.max(48, Math.min(120, W * 0.08));
      params.perception = Math.max(90, Math.min(150, W * 0.12));
      measureAvoid();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      for (const n of nodes) n.remove();
    };
  }, []);

  return <div ref={ref} className="hero-scene" aria-hidden="true" />;
}
