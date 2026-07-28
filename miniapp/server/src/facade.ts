/**
 * The sanctioned Aside CLI facade.
 *
 * `aside repl "<js>"` evaluates JavaScript against the running Aside
 * daemon and prints whatever the script logs. That is the supported way to
 * reach real session metadata -- titles, status, read state, structured
 * transcripts -- none of which can be derived faithfully from the raw
 * messages.jsonl on disk.
 *
 * Two things make the transport fiddly and are handled here once:
 *
 *  - The CLI appends its own ANSI-coloured `[ok | 12ms]` trailer to
 *    stdout, so raw stdout is never valid JSON. We wrap every payload in
 *    sentinels rather than guessing which line is ours.
 *  - Each call spawns a ~139MB binary. Results are therefore cached with a
 *    short TTL and identical in-flight calls are coalesced.
 */
import { execFile } from 'node:child_process';

const BEGIN = '<<<ASIDE_JSON';
const END = 'ASIDE_JSON>>>';

export interface FacadeOptions {
  asideCli: string;
  timeoutMs?: number;
  /** Injected in tests so the cache can be exercised without spawning. */
  runFn?: (expression: string) => Promise<unknown>;
}

export class FacadeError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'FacadeError';
  }
}

/**
 * Pull our payload out of the CLI's chatty stdout.
 *
 * Exported because the sentinel contract is exactly the sort of thing that
 * breaks silently on a CLI upgrade, so it is covered directly by tests.
 */
export function parseFacadeOutput(stdout: string): unknown {
  const start = stdout.indexOf(BEGIN);
  const end = stdout.indexOf(END, start + BEGIN.length);
  if (start === -1 || end === -1) {
    throw new FacadeError(
      `aside repl produced no payload (stdout: ${stdout.slice(0, 200)})`,
    );
  }
  const json = stdout.slice(start + BEGIN.length, end);
  try {
    return JSON.parse(json) as unknown;
  } catch (err) {
    throw new FacadeError(
      `aside repl payload was not JSON: ${(err as Error).message}`,
    );
  }
}

/**
 * Evaluate `expression` (an async-capable JS expression) in the daemon and
 * return its JSON value.
 */
export function runFacade(
  opts: FacadeOptions,
  expression: string,
): Promise<unknown> {
  // `undefined` is not valid JSON; null keeps the sentinel parse total.
  const script =
    `const __v = await (async () => (${expression}))();` +
    `console.log(${JSON.stringify(BEGIN)} + JSON.stringify(__v ?? null) + ${JSON.stringify(END)});`;

  return new Promise((resolve, reject) => {
    execFile(
      opts.asideCli,
      ['repl', script],
      {
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err && !stdout.includes(BEGIN)) {
          reject(
            new FacadeError(
              `aside repl failed: ${err.message}`,
              String(stderr).slice(0, 500),
            ),
          );
          return;
        }
        try {
          resolve(parseFacadeOutput(String(stdout)));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

interface CacheEntry {
  at: number;
  value: unknown;
}

/**
 * TTL cache with in-flight coalescing.
 *
 * Both halves matter: the TTL stops a polling client from spawning a
 * process per request, and the in-flight map stops a burst of concurrent
 * requests (the WS reconnect storm after a phone unlocks, typically) from
 * spawning several at once for the same key.
 */
/** Bounded: the key is per-session, and there are thousands of sessions. */
const MAX_FACADE_ENTRIES = 256;

export class FacadeCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private opts: FacadeOptions,
    private now: () => number = Date.now,
  ) {}

  private run(expression: string): Promise<unknown> {
    return this.opts.runFn
      ? this.opts.runFn(expression)
      : runFacade(this.opts, expression);
  }

  async call<T>(key: string, expression: string, ttlMs: number): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;

    const pending = this.inflight.get(key);
    if (pending) return (await pending) as T;

    const promise = this.run(expression)
      .then((value) => {
        this.entries.delete(key);
        this.entries.set(key, { at: this.now(), value });
        while (this.entries.size > MAX_FACADE_ENTRIES) {
          const oldest = this.entries.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
        }
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return (await promise) as T;
  }

  /** Fire-and-forget mutations must never be served from cache. */
  mutate(expression: string): Promise<unknown> {
    return this.run(expression);
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }
}

/** A session as the daemon knows it -- the shape `aside.sessions.list()` returns. */
export interface FacadeSession {
  id: string;
  title?: string;
  status?: 'running' | 'idle' | 'errored' | string;
  incognito?: boolean;
  ephemeral?: boolean;
  readAt?: string;
  createdAt?: string;
  updatedAt?: string;
  routineId?: string;
  trigger?: { type?: string; source?: string; title?: string };
}

export interface FacadeMessage {
  role: string;
  content: unknown;
  model?: string;
  provider?: string;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  kind?: string;
}

export interface FacadeDefaultModel {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  fastMode?: boolean;
}

/** JS literal for a string that is about to be interpolated into repl code. */
function lit(value: string): string {
  return JSON.stringify(value);
}

export function fetchSessions(
  cache: FacadeCache,
  limit = 100,
): Promise<FacadeSession[]> {
  return cache
    .call<FacadeSession[] | null>(
      `sessions:${limit}`,
      `aside.sessions.list({ limit: ${Number(limit) | 0} })`,
      4_000,
    )
    .then((rows) => (Array.isArray(rows) ? rows : []));
}

export function fetchSession(
  cache: FacadeCache,
  id: string,
): Promise<FacadeSession | null> {
  return cache.call<FacadeSession | null>(
    `session:${id}`,
    `aside.sessions.get(${lit(id)})`,
    4_000,
  );
}

/*
 * There is deliberately no `fetchMessages` here any more.
 *
 * `aside.sessions.messages(id)` returns the agent's current CONTEXT rather
 * than the conversation, which is why round 3 moved every read onto the
 * transcript on disk (see jsonl.ts). The wrapper survived that move with no
 * callers, which is exactly the sort of leftover that gets picked back up by
 * someone who assumes it is the supported path.
 */

export function fetchDefaultModel(
  cache: FacadeCache,
): Promise<FacadeDefaultModel | null> {
  return cache.call<FacadeDefaultModel | null>(
    'settings:defaultModel',
    'aside.settings.getAll().defaultModel',
    30_000,
  );
}

/**
 * Clear a session's unread state, mirroring what opening it in the browser
 * sidepanel does. Best-effort: a failure here must never block a read.
 */
export async function markSessionRead(
  cache: FacadeCache,
  id: string,
): Promise<boolean> {
  try {
    await cache.mutate(`aside.sessions.markRead(${lit(id)})`);
    cache.invalidate(`session:${id}`);
    return true;
  } catch {
    return false;
  }
}
