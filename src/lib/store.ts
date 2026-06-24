// ---------------------------------------------------------------------------
// Storage abstraction (server-only).
//
// Vercel KV is no longer offered, so this layer talks to Upstash Redis
// (KV-compatible, provisioned via the Vercel Marketplace) when env vars are
// present, and falls back to a local file-based store under ./.flock-data for
// development so the app runs with zero provisioning.
//
// The flock is a single document; there is no per-user secret. Access control is
// the shared link itself, and edit governance is the advisory lock state stored on
// the session (see types.ts SectionLocks / runnerLocks).
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

import { createLogger } from "./logger";
import type { FlockSession } from "./types";

const log = createLogger("store");

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const flockKey = (id: string) => `flock:${id}`;

export interface FlockStore {
  backend: string;
  createFlock(session: FlockSession): Promise<void>;
  getFlock(id: string): Promise<FlockSession | null>;
  saveFlock(session: FlockSession): Promise<void>; // upsert + reset TTL
}

// --- Upstash Redis backend ---------------------------------------------------

class RedisStore implements FlockStore {
  backend = "upstash-redis";
  private redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async createFlock(session: FlockSession): Promise<void> {
    await this.redis.set(flockKey(session.id), session, { ex: TTL_SECONDS });
  }

  async getFlock(id: string): Promise<FlockSession | null> {
    const data = await this.redis.get<FlockSession>(flockKey(id));
    return data ?? null;
  }

  async saveFlock(session: FlockSession): Promise<void> {
    await this.redis.set(flockKey(session.id), session, { ex: TTL_SECONDS });
  }
}

// --- Local file backend (dev only) ------------------------------------------

interface FileEnvelope {
  session: FlockSession;
  expiresAt: number; // epoch ms
}

class FileStore implements FlockStore {
  backend = "file (dev)";
  private dir = path.join(process.cwd(), ".flock-data");

  private file(id: string): string {
    return path.join(this.dir, `flock-${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async read(id: string): Promise<FileEnvelope | null> {
    try {
      const raw = await fs.readFile(this.file(id), "utf8");
      const env = JSON.parse(raw) as FileEnvelope;
      if (Date.now() > env.expiresAt) {
        await fs.unlink(this.file(id)).catch(() => {});
        log.debug("file flock expired and removed", { id });
        return null;
      }
      return env;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async write(env: FileEnvelope): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.file(env.session.id), JSON.stringify(env, null, 2), "utf8");
  }

  async createFlock(session: FlockSession): Promise<void> {
    await this.write({ session, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  }

  async getFlock(id: string): Promise<FlockSession | null> {
    const env = await this.read(id);
    return env?.session ?? null;
  }

  async saveFlock(session: FlockSession): Promise<void> {
    await this.write({ session, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  }
}

// --- Singleton selection -----------------------------------------------------

let _store: FlockStore | null = null;

export function getStore(): FlockStore {
  if (_store) return _store;

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    _store = new RedisStore(url, token);
    log.info("storage backend selected", { backend: _store.backend });
  } else {
    _store = new FileStore();
    log.warn("storage backend selected — NO Redis env found, using local files", {
      backend: _store.backend,
      hint: "set KV_REST_API_URL + KV_REST_API_TOKEN for production",
    });
  }
  return _store;
}
