import { NextResponse } from "next/server";

import { applyPatch, getFlock } from "@/lib/flockService";
import { createLogger } from "@/lib/logger";
import { RouteError } from "@/lib/ors";
import { calculateRoutes } from "@/lib/flock";

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
    // A calc reads the session, then makes many (slow) ORS calls, then writes the
    // routes back. If a waypoint/participant edit lands DURING that window, naively
    // writing would overwrite the newer plan with routes computed from the old one
    // — the edit looks "ignored". So we persist ONLY if the plan is unchanged since
    // we read it (setRoutes' expectedUpdatedAt guard); if it changed, recompute
    // against the now-current plan. Bounded so a burst of edits can't loop forever
    // (the client re-triggers once editing settles).
    const MAX_TRIES = 3;
    // Wall-clock backstop: never start another (slow) recompute if we're near the
    // function's maxDuration. If we run out of tries/time, the client retries (with
    // backoff) once editing settles — so we converge without risking a timeout.
    const TIME_BUDGET_MS = 45_000;
    const startedAt = Date.now();
    let result = null as Awaited<ReturnType<typeof calculateRoutes>> | null;
    let persisted = false;
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      if (tries > 0 && Date.now() - startedAt > TIME_BUDGET_MS) {
        log.warn("calc time budget spent — leaving for the client to retry", {
          flockId,
          elapsedMs: Date.now() - startedAt,
        });
        break;
      }
      const session = await getFlock(flockId);
      if (!session) {
        done({ error: "not-found" });
        return NextResponse.json({ error: "Flock not found" }, { status: 404 });
      }
      const basedOn = session.updatedAt;
      result = await calculateRoutes(session);
      if (result.skipped) break;
      const applied = await applyPatch(flockId, {
        action: "setRoutes",
        computedRoutes: result.routes,
        sharedSegments: result.sharedSegments,
        flockRoute: result.flockRoute,
        waypointEtas: result.waypointEtas,
        expectedUpdatedAt: basedOn,
      });
      if (!applied.stale) {
        persisted = true;
        break;
      }
      log.info("plan changed during calc — recomputing", { flockId, attempt: tries + 1 });
    }
    if (!result) {
      done({ error: "no-result" });
      return NextResponse.json({ error: "Could not work out routes" }, { status: 500 });
    }

    done({
      flockId,
      routes: result.routes.length,
      shared: result.sharedSegments.length,
      together: result.summary.totalTogetherMinutes,
      warnings: result.warnings.length,
      persisted,
      skipped: result.skipped,
    });

    // `persisted: false` (and not skipped) means we computed routes but the plan
    // kept changing under us — the routes were NOT saved, so the client must retry.
    return NextResponse.json(
      {
        summary: result.summary,
        warnings: result.warnings,
        routeCount: result.routes.length,
        sharedCount: result.sharedSegments.length,
        persisted: result.skipped ? true : persisted,
        skipped: result.skipped,
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
