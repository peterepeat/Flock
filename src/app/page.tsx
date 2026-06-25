"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { createLogger } from "@/lib/logger";
import type { CreateFlockResponse } from "@/lib/types";

// Decorative animated illustration — client-only (uses per-load randomness).
const HeroScene = dynamic(() => import("@/components/HeroScene"), { ssr: false });

const log = createLogger("landing");

export default function LandingPage() {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startFlock() {
    setStarting(true);
    setError(null);
    log.info("starting a new flock");
    try {
      const res = await fetch("/api/flocks/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      const data = (await res.json()) as CreateFlockResponse;
      log.info("flock created, redirecting", { id: data.id });
      router.push(`/flock/${data.id}`);
    } catch (err) {
      log.error("could not start flock", { error: String(err) });
      setError("Something went wrong starting your flock. Try again.");
      setStarting(false);
    }
  }

  return (
    <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-6">
      {/* Animated flock-party illustration */}
      <HeroScene />
      {/* Dawn glow + a soft vignette behind the copy so it stays crisp over the scene */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(58% 44% at 50% 47%, rgba(20,20,26,0.86) 0%, rgba(20,20,26,0.45) 38%, transparent 72%), radial-gradient(120% 80% at 50% 110%, rgba(232,97,42,0.16) 0%, rgba(58,191,176,0.09) 35%, transparent 70%)",
        }}
      />
      <div className="relative z-10 flex max-w-xl flex-col items-center text-center">
        <h1 className="text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Find your flock.
        </h1>
        <p className="mt-6 max-w-md text-lg leading-relaxed text-text-dim">
          Everyone starts somewhere. Flock Party figures out the routes so you spend
          as much time running together as possible. Lock it in, download your routes,
          and watch the whole run come to life.
        </p>

        <button
          onClick={startFlock}
          disabled={starting}
          className="mt-10 rounded-full bg-accent px-8 py-3.5 text-base font-medium text-white shadow-panel transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {starting ? "Starting…" : "Start your flock party →"}
        </button>

        {error && <p className="mt-4 text-sm text-accent">{error}</p>}
      </div>
    </main>
  );
}
