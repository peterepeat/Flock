import { getFlock } from "@/lib/flockService";
import { buildGpx } from "@/lib/gpx";
import { createLogger } from "@/lib/logger";

const log = createLogger("api:gpx");

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { flockId: string; participantId: string } },
) {
  const done = log.time("gpx", params);
  try {
    const session = await getFlock(params.flockId);
    if (!session) {
      done({ error: "not-found" });
      return new Response("Flock not found", { status: 404 });
    }

    const gpx = buildGpx(session, params.participantId);
    if (!gpx) {
      done({ error: "no-route" });
      return new Response("No route to download yet", { status: 404 });
    }

    done({ filename: gpx.filename, bytes: gpx.xml.length });
    return new Response(gpx.xml, {
      status: 200,
      headers: {
        "Content-Type": "application/gpx+xml",
        "Content-Disposition": `attachment; filename="${gpx.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    log.error("gpx failed", { ...params, error: String(err) });
    done({ error: true });
    return new Response("Could not generate your route", { status: 500 });
  }
}
