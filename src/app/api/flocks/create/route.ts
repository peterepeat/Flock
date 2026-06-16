import { NextResponse } from "next/server";

import { createFlock } from "@/lib/flockService";
import { createLogger } from "@/lib/logger";
import type { CreateFlockResponse, Unit } from "@/lib/types";

const log = createLogger("api:flocks/create");

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const done = log.time("create");
  try {
    let unit: Unit = "km";
    try {
      const body = (await request.json()) as { unitPreference?: Unit } | null;
      if (body?.unitPreference === "km" || body?.unitPreference === "miles") {
        unit = body.unitPreference;
      }
    } catch {
      // No / empty body is fine — default unit.
    }

    const session = await createFlock(unit);
    const base =
      process.env.NEXT_PUBLIC_APP_URL ||
      new URL(request.url).origin;
    const payload: CreateFlockResponse = {
      id: session.id,
      url: `${base}/flock/${session.id}`,
    };
    done({ id: session.id });
    return NextResponse.json(payload, { status: 201 });
  } catch (err) {
    log.error("create failed", { error: String(err) });
    done({ error: true });
    return NextResponse.json({ error: "Could not start a flock" }, { status: 500 });
  }
}
