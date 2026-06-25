// Focused tests for the kv cache + single-flight lock and the ORS cache wrapper. Pure: a counting
// fake-fetch (so we can assert ORS calls are SAVED) and no Redis env (in-memory backend).
//   run: npx tsx scripts/_st_cache.ts

// No Redis → in-memory backend; counting fake ORS so we can prove cache hits skip the network.
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.ORS_API_KEY = "fake";
process.env.FLOCK_LOG_LEVEL = "error";

let orsCalls = 0;
globalThis.fetch = (async (_u: string, opts: { body: string }) => {
  orsCalls++;
  const body = JSON.parse(opts.body) as { coordinates: [number, number][] };
  const coords = body.coordinates.length >= 2 ? body.coordinates : [body.coordinates[0], [body.coordinates[0][0] + 0.01, body.coordinates[0][1] + 0.01]];
  return new Response(
    JSON.stringify({ features: [{ geometry: { type: "LineString", coordinates: coords }, properties: { summary: { distance: 1.2, duration: 720 } } }] }),
    { status: 200, headers: { "content-type": "application/geo+json", "x-ratelimit-remaining": "1000" } },
  );
}) as unknown as typeof fetch;

import { getRoute } from "../src/lib/ors";
import { BUSY, cacheGet, cacheSet, withLock } from "../src/lib/kv";

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fails.push(msg); console.log(`  ✗ FAIL  ${msg}`); } };
const A = { lat: -37.8, lng: 144.96 }, B = { lat: -37.84, lng: 144.97 }, C = { lat: -37.81, lng: 144.99 };

async function main() {
  console.log("\n══ kv cache + single-flight ══");

  console.log("\n— cache get/set —");
  ok((await cacheGet("missing-key")) === null, "a missing key reads null");
  await cacheSet("k1", { hello: 1 }, 60);
  ok(JSON.stringify(await cacheGet("k1")) === JSON.stringify({ hello: 1 }), "set then get round-trips the value");

  console.log("\n— ORS getRoute is cached (identical request skips the network) —");
  orsCalls = 0;
  const r1 = await getRoute([A, B]);
  ok(orsCalls === 1, `first getRoute hits ORS once (calls=${orsCalls})`);
  const r2 = await getRoute([A, B]);
  ok(orsCalls === 1, `identical getRoute is served from cache, NO new ORS call (calls=${orsCalls})`);
  ok(JSON.stringify(r1.geometry) === JSON.stringify(r2.geometry), "cached result equals the fresh one");
  await getRoute([A, C]);
  ok(orsCalls === 2, `a DIFFERENT request does hit ORS (calls=${orsCalls})`);
  await getRoute([{ lat: A.lat + 1e-9, lng: A.lng }, B]);
  ok(orsCalls === 2, "a sub-rounding coordinate jitter still hits the cache (no new call)");

  console.log("\n— single-flight lock (concurrent callers collapse to one) —");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ran = 0;
  const holder = withLock("lock:x", 60, async () => { ran++; await gate; return "result"; });
  await Promise.resolve(); // let the holder acquire
  const busy = await withLock("lock:x", 60, async () => { ran++; return "should-not-run"; });
  ok(busy === BUSY, "a second caller on a held lock gets BUSY without running fn");
  ok(ran === 1, "the second caller's fn never ran");
  release();
  ok((await holder) === "result", "the holder completes and returns its result");
  const after = await withLock("lock:x", 60, async () => "fresh");
  ok(after === "fresh", "once released, the lock can be re-acquired");

  console.log(`\n${fails.length === 0 ? "✅ ALL PASS" : `❌ ${fails.length} FAILED`}  (${pass}/${pass + fails.length})`);
  if (fails.length) { for (const f of fails) console.log("  · " + f); process.exit(1); }
  process.exit(0);
}
void main();
