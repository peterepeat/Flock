import { NextResponse } from "next/server";

import { applyPatch, getFlock } from "@/lib/flockService";
import { createLogger } from "@/lib/logger";
import { RouteError } from "@/lib/ors";
import { calculateRoutes } from "@/lib/routeEngine";

const log = createLogger("api:routes/calculate");

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const done = log.time("calculate-request");
  let flockId: string;
  try {
    const body = (await request.json()) as { flockId?: string };
    flockId = body?.flockId ?? "";
  } catch {
    done({ error: "bad-json" });
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!flockId) {
    done({ error: "no-id" });
    return NextResponse.json({ error: "flockId is required" }, { status: 400 });
  }

  try {
    const session = await getFlock(flockId);
    if (!session) {
      done({ error: "not-found" });
      return NextResponse.json({ error: "Flock not found" }, { status: 404 });
    }

    const result = await calculateRoutes(session);

    // Persist routes so every polling client picks them up (and GPX can read them).
    if (!result.skipped) {
      await applyPatch(flockId, {
        action: "setRoutes",
        computedRoutes: result.routes,
        sharedSegments: result.sharedSegments,
        flockRoute: result.flockRoute,
        waypointEtas: result.waypointEtas,
      });
    }

    done({
      flockId,
      routes: result.routes.length,
      shared: result.sharedSegments.length,
      together: result.summary.totalTogetherMinutes,
      warnings: result.warnings.length,
    });

    return NextResponse.json(
      {
        summary: result.summary,
        warnings: result.warnings,
        routeCount: result.routes.length,
        sharedCount: result.sharedSegments.length,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Daily quota spent → a distinct, actionable signal (won't recover until
    // reset), so the client can say so and stop hammering.
    if (err instanceof RouteError && err.code === "quota-exhausted") {
      log.warn("calculate hit daily quota", { flockId, resetAt: err.resetAt });
      done({ quota: true });
      return NextResponse.json(
        { error: "Daily routing limit reached", code: "quota", resetAt: err.resetAt ?? null },
        { status: 429 },
      );
    }
    log.error("calculate failed", { flockId, error: String(err) });
    done({ error: true });
    return NextResponse.json({ error: "Could not work out routes" }, { status: 500 });
  }
}
