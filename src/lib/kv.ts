// ---------------------------------------------------------------------------
// Tiny KV primitive (server-only): a cross-instance cache + a single-flight lock.
//
// Rides on the SAME Upstash Redis the session store uses (cross-instance) when its
// env vars are present, and falls back to an in-process Map for local dev / when no
// Redis is configured. Deliberately DECOUPLED from anything app-specific: it deals in
// opaque string keys and JSON values, so the routing engine, the ORS client, and the
// calc endpoint can lean on it without it ever knowing what they store.
//
// Everything degrades gracefully: a flaky/absent Redis makes the cache a miss and the
// lock a no-op (every caller "acquires"), so correctness never depends on it — only the
// load savings do.
// ---------------------------------------------------------------------------

import { Redis } from "@upstash/redis";

import { createLogger } from "./logger";

const log = createLogger("kv");

// --- backend selection (mirrors store.ts; its own client so the two stay decoupled) ---
let _redis: Redis | null | undefined;
function redis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  log.info("kv backend", { backend: _redis ? "upstash-redis" : "in-memory (dev)" });
  return _redis;
}

// --- in-process fallback (dev / no Redis): a bounded TTL map + a lock map ---
interface Entry {
  value: unknown;
  expiresAt: number;
}
const mem = new Map<string, Entry>();
const memLocks = new Map<string, number>(); // key → expiry epoch-ms
const MEM_MAX = 2000;
const nowMs = () => Date.now();

// --- cache -----------------------------------------------------------------
export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = redis();
  if (r) {
    try {
      return (await r.get<T>(key)) ?? null;
    } catch (err) {
      log.warn("cache get failed — treating as miss", { error: String(err) });
      return null;
    }
  }
  const e = mem.get(key);
  if (!e) return null;
  if (e.expiresAt < nowMs()) {
    mem.delete(key);
    return null;
  }
  return e.value as T;
}

export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  const r = redis();
  if (r) {
    try {
      await r.set(key, value, { ex: ttlSec });
    } catch (err) {
      log.warn("cache set failed — skipping", { error: String(err) });
    }
    return;
  }
  if (mem.size >= MEM_MAX) {
    const oldest = mem.keys().next().value; // FIFO eviction is plenty for a TTL cache
    if (oldest !== undefined) mem.delete(oldest);
  }
  mem.set(key, { value, expiresAt: nowMs() + ttlSec * 1000 });
}

// --- single-flight lock ----------------------------------------------------
// Returned (instead of T) when the lock is already held — the caller should NOT run fn.
export const BUSY = Symbol("kv-busy");

/**
 * Run `fn` while holding an exclusive lock on `key`; if someone else holds it, return BUSY
 * WITHOUT running fn (the caller decides how to wait). The lock auto-expires after ttlSec so a
 * crashed holder can't wedge it, and is released as soon as fn settles. A Redis hiccup degrades
 * to "no lock" (fn runs) rather than blocking work.
 */
export async function withLock<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T | typeof BUSY> {
  const r = redis();
  let held = false;
  if (r) {
    try {
      held = (await r.set(key, "1", { nx: true, ex: ttlSec })) === "OK";
    } catch (err) {
      log.warn("lock acquire failed — proceeding unlocked", { error: String(err) });
      held = true; // degrade: never block real work on a flaky lock
    }
  } else {
    const exp = memLocks.get(key);
    held = !(exp && exp > nowMs());
    if (held) memLocks.set(key, nowMs() + ttlSec * 1000);
  }
  if (!held) return BUSY;
  try {
    return await fn();
  } finally {
    if (r) await r.del(key).catch(() => {}); // best-effort; the TTL is the backstop
    else memLocks.delete(key);
  }
}
