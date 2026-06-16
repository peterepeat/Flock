import { NextResponse } from "next/server";

import { applyPatch, getFlock } from "@/lib/flockService";
import { createLogger } from "@/lib/logger";
import type { PatchAction } from "@/lib/types";

const log = createLogger("api:flocks/[id]");

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const done = log.time("get", { id: params.id });
  try {
    const session = await getFlock(params.id);
    if (!session) {
      done({ found: false });
      return NextResponse.json({ error: "Flock not found" }, { status: 404 });
    }
    done({ found: true, participants: session.participants.length });
    // Tokens live in a separate key and are never part of the session object.
    return NextResponse.json(session, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    log.error("get failed", { id: params.id, error: String(err) });
    done({ error: true });
    return NextResponse.json({ error: "Could not load flock" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const done = log.time("patch", { id: params.id });
  let action: PatchAction;
  try {
    action = (await request.json()) as PatchAction;
  } catch {
    done({ error: "bad-json" });
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!action || typeof action.action !== "string") {
    done({ error: "no-action" });
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  try {
    const result = await applyPatch(params.id, action);
    done({ action: action.action, status: result.status });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(
      { session: result.session, participantId: result.participantId },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    log.error("patch failed", { id: params.id, action: action.action, error: String(err) });
    done({ error: true });
    return NextResponse.json({ error: "Could not update flock" }, { status: 500 });
  }
}
