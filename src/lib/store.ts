// ---------------------------------------------------------------------------
// Storage abstraction (server-only).
//
// Vercel KV is no longer offered, so this layer talks to Upstash Redis
// (KV-compatible, provisioned via the Vercel Marketplace) when env vars are
// present, and falls back to a local file-based store under ./.flock-data for
// development so the app runs with zero provisioning.
//
// Edit tokens are stored ONLY as SHA-256 hashes, in a separate key that is
// never returned by GET /api/flocks/[id]. The raw token lives in the creator's
// localStorage. This gives a soft "edit only your own entry on this device"
// guard on an otherwise fully-public link.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

import { createLogger } from "./logger";
import type { FlockSession } from "./types";

const log = createLogger("store");

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const flockKey = (id: string) => `flock:${id}`;
const tokensKey = (id: string) => `flock:${id}:tokens`;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface FlockStore {
  backend: string;
  createFlock(session: FlockSession): Promise<void>;
  getFlock(id: string): Promise<FlockSession | null>;
  saveFlock(session: FlockSession): Promise<void>; // upsert + reset TTL
  getTokenHash(id: string, participantId: string): Promise<string | null>;
  setTokenHash(id: string, participantId: string, hash: string): Promise<void>;
  deleteTokenHash(id: string, participantId: string): Promise<void>;
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

  async getTokenHash(id: string, participantId: string): Promise<string | null> {
    const hash = await this.redis.hget<string>(tokensKey(id), participantId);
    return hash ?? null;
  }

  async setTokenHash(id: string, participantId: string, hash: string): Promise<void> {
    await this.redis.hset(tokensKey(id), { [participantId]: hash });
    await this.redis.expire(tokensKey(id), TTL_SECONDS);
  }

  async deleteTokenHash(id: string, participantId: string): Promise<void> {
    await this.redis.hdel(tokensKey(id), participantId);
  }
}

// --- Local file backend (dev only) ------------------------------------------

interface FileEnvelope {
  session: FlockSession;
  tokens: Record<string, string>; // participantId -> hash
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
    await this.write({
      session,
      tokens: {},
      expiresAt: Date.now() + TTL_SECONDS * 1000,
    });
  }

  async getFlock(id: string): Promise<FlockSession | null> {
    const env = await this.read(id);
    return env?.session ?? null;
  }

  async saveFlock(session: FlockSession): Promise<void> {
    const env = (await this.read(session.id)) ?? { session, tokens: {}, expiresAt: 0 };
    env.session = session;
    env.expiresAt = Date.now() + TTL_SECONDS * 1000;
    await this.write(env);
  }

  async getTokenHash(id: string, participantId: string): Promise<string | null> {
    const env = await this.read(id);
    return env?.tokens[participantId] ?? null;
  }

  async setTokenHash(id: string, participantId: string, hash: string): Promise<void> {
    const env = await this.read(id);
    if (!env) return;
    env.tokens[participantId] = hash;
    await this.write(env);
  }

  async deleteTokenHash(id: string, participantId: string): Promise<void> {
    const env = await this.read(id);
    if (!env) return;
    delete env.tokens[participantId];
    await this.write(env);
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
