/**
 * SystemLogger — typed log-event stream.
 *
 * Architecturally identical to the patch-application primitive the rest of
 * the source package implements: each `log(event)` call is a patch against
 * an implicit "system log" structure; subscribers consume the patch
 * stream. There is no separate logging mechanism — the logger IS just a
 * `subscribe + applyPatch` pair, which is the same shape every typed
 * value in the runtime has.
 *
 * Wiring story:
 *
 *   - In dev / unit tests with no subscribers: the default logger falls
 *     back to `console.*` so log events still surface.
 *   - In production: a host installs a real subscriber (typically one
 *     that forwards each event to a Source-backed log process — i.e.,
 *     the system log IS a process-cell in the same runtime). Then logs
 *     are durable, replayable, and queryable like any other typed state.
 *
 * The singleton is for ergonomics — every DAO and substrate file can
 * just `log.error(...)` without threading a logger through constructors.
 * Production code that wants explicit control passes a logger instance
 * directly (currently no DAO supports this; refactor to constructor
 * injection if/when that becomes important).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEvent = {
  readonly level: LogLevel;
  /** Module identifier — e.g. "@console-one/source/dao/update". */
  readonly source: string;
  readonly message: string;
  /** Optional structured context — error objects, ids, durations. */
  readonly context?: Record<string, unknown>;
  /** Wall-clock millis at log time. */
  readonly timestamp: number;
};

/**
 * The minimal logger interface — the patch-stream primitive.
 *
 *   `log(event)`    — apply a patch (append a log event to the stream)
 *   `subscribe(cb)` — receive each subsequent event
 *
 * Same shape as any typed value in the runtime: write + observe.
 */
export interface SystemLogger {
  log(event: Omit<LogEvent, "timestamp">): void;
  subscribe(cb: (event: LogEvent) => void): () => void;
}

/**
 * Default in-memory implementation. If no subscriber is attached,
 * falls back to `console.*` so log events aren't lost in dev / tests.
 * When subscribers are attached, the console fallback is suppressed —
 * subscribers are responsible for whatever output / persistence is
 * desired.
 */
export class DefaultSystemLogger implements SystemLogger {
  private subscribers = new Set<(event: LogEvent) => void>();

  log(input: Omit<LogEvent, "timestamp">): void {
    const event: LogEvent = { ...input, timestamp: Date.now() };
    if (this.subscribers.size === 0) {
      this.consoleFallback(event);
    } else {
      for (const cb of this.subscribers) cb(event);
    }
  }

  subscribe(cb: (event: LogEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private consoleFallback(event: LogEvent): void {
    const method =
      event.level === "debug"
        ? "log"
        : (event.level as "info" | "warn" | "error");
    const ctx = event.context !== undefined ? event.context : "";
    // eslint-disable-next-line no-console
    (console[method] as (...args: unknown[]) => void)(
      `[${event.source}] ${event.message}`,
      ctx,
    );
  }
}

let activeLogger: SystemLogger = new DefaultSystemLogger();

/** Override the active logger. Hosts call this at boot. */
export function setSystemLogger(logger: SystemLogger): void {
  activeLogger = logger;
}

/** Read the active logger. Mostly for tests; production code uses `log.*`. */
export function getSystemLogger(): SystemLogger {
  return activeLogger;
}

/**
 * Convenience helpers — what most callers actually use.
 *
 *   log.error("source/dao/update", "Update save failed", { err })
 *   log.info("kernel", "Manifest loaded", { url })
 *
 * Each call appends one event to the active logger's stream.
 */
export const log = {
  debug(source: string, message: string, context?: Record<string, unknown>) {
    activeLogger.log({ level: "debug", source, message, context });
  },
  info(source: string, message: string, context?: Record<string, unknown>) {
    activeLogger.log({ level: "info", source, message, context });
  },
  warn(source: string, message: string, context?: Record<string, unknown>) {
    activeLogger.log({ level: "warn", source, message, context });
  },
  error(source: string, message: string, context?: Record<string, unknown>) {
    activeLogger.log({ level: "error", source, message, context });
  },
};
