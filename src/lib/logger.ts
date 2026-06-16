// ---------------------------------------------------------------------------
// Structured, namespaced logger.
//
// Designed so that the complex build steps (ORS routing, together-time analysis,
// GPX export) can emit dense, greppable diagnostics. Every line carries a
// timestamp, level, namespace, message and an optional structured context blob.
//
// Usage:
//   const log = createLogger("api:routes/calculate");
//   log.info("starting", { participants: 5 });
//   const done = log.time("ors-call", { participantId });
//   ... await ...
//   done({ distanceKm });           // logs elapsed ms automatically
//
// Verbosity is controlled by FLOCK_LOG_LEVEL (server) or
// NEXT_PUBLIC_FLOCK_LOG_LEVEL (client). Defaults: debug in dev, info in prod.
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const isServer = typeof window === "undefined";

function resolveLevel(): LogLevel {
  const raw =
    (isServer
      ? process.env.FLOCK_LOG_LEVEL
      : process.env.NEXT_PUBLIC_FLOCK_LOG_LEVEL) || "";
  const candidate = raw.toLowerCase();
  if (candidate in LEVEL_WEIGHT) return candidate as LogLevel;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const ACTIVE_LEVEL = resolveLevel();
const ACTIVE_WEIGHT = LEVEL_WEIGHT[ACTIVE_LEVEL];

// A short correlation id so concurrent requests can be told apart in logs.
function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

type Context = Record<string, unknown> | undefined;

function safeContext(ctx: Context): string {
  if (!ctx || Object.keys(ctx).length === 0) return "";
  try {
    return " " + JSON.stringify(ctx);
  } catch {
    // Guard against circular structures / non-serialisable values.
    try {
      return " " + JSON.stringify(ctx, replaceCircular());
    } catch {
      return " [unserialisable-context]";
    }
  }
}

function replaceCircular() {
  const seen = new WeakSet();
  return (_key: string, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  };
}

export interface Logger {
  /** Child logger with an extended namespace, e.g. log.child("pair:A-B"). */
  child(suffix: string): Logger;
  debug(message: string, context?: Context): void;
  info(message: string, context?: Context): void;
  warn(message: string, context?: Context): void;
  error(message: string, context?: Context): void;
  /**
   * Start a timer. Returns a function to call when the operation finishes;
   * calling it logs the elapsed milliseconds (at debug) plus any extra context.
   */
  time(label: string, context?: Context): (extra?: Context) => number;
}

function emit(level: LogLevel, namespace: string, message: string, context: Context) {
  if (LEVEL_WEIGHT[level] < ACTIVE_WEIGHT) return;

  const ts = new Date().toISOString();
  const where = isServer ? "srv" : "cli";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${where}:${namespace}] ${message}${safeContext(
    context,
  )}`;

  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

export function createLogger(namespace: string): Logger {
  return {
    child(suffix: string) {
      return createLogger(`${namespace}:${suffix}`);
    },
    debug(message, context) {
      emit("debug", namespace, message, context);
    },
    info(message, context) {
      emit("info", namespace, message, context);
    },
    warn(message, context) {
      emit("warn", namespace, message, context);
    },
    error(message, context) {
      emit("error", namespace, message, context);
    },
    time(label, context) {
      const id = shortId();
      const start = Date.now();
      emit("debug", namespace, `▶ ${label} start`, { _t: id, ...context });
      return (extra?: Context) => {
        const ms = Date.now() - start;
        emit("debug", namespace, `■ ${label} done`, { _t: id, ms, ...extra });
        return ms;
      };
    },
  };
}

export const activeLogLevel = ACTIVE_LEVEL;
