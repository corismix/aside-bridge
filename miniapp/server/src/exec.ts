/**
 * Turn execution: `aside exec` as a child process, one in-flight turn per
 * session, everything else queued.
 *
 * Ported from bridge.py's worker loop. Two behaviours from there matter:
 *  - Serial per session. The CLI silently drops prompts sent to a busy
 *    session, so a second concurrent turn is not "parallel", it is lost.
 *  - Adjacent queued messages batch into one turn (joined by a blank line)
 *    when they share model and effort, which is what makes rapid-fire
 *    typing behave sanely.
 *
 * Args are passed as an argv array (never a shell string), so prompt text
 * needs no quoting and cannot inject.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { EFFORT_LEVELS, type EffortLevel } from './config.js';
import { ProseFilter, stripAnsi } from './prose.js';

export interface TurnRequest {
  text: string;
  model: string;
  effort: EffortLevel;
}

/**
 * A slice of the assistant's answer, straight off the child's stdout.
 *
 * Provisional by construction: the transcript is still the source of truth
 * and replaces this the moment the message's jsonl line is written.
 */
export interface StreamDelta {
  sessionId: string;
  text: string;
}

export interface InFlightTurn {
  sessionId: string;
  model: string;
  effort: EffortLevel;
  startedAt: number;
  /** True until the CLI has created the session directory. */
  pending?: boolean;
}

export interface TurnFinished {
  sessionId: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface RunnerOptions {
  asideCli: string;
  sessionsDir: string;
  execTimeoutMs: number;
  defaultModel: string;
  defaultEffort: EffortLevel;
  modelAliases: Record<string, string>;
  /** Run `aside repl` to grant full-access on freshly created sessions. */
  grantFullAccess?: boolean;
  /** Injection seam for tests. */
  spawnFn?: typeof spawn;
}

interface SessionQueue {
  running: InFlightTurn | null;
  child: ChildProcess | null;
  queued: TurnRequest[];
}

export function isEffort(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel);
}

/**
 * Pull the daemon's model-unavailable notice out of a captured stream.
 *
 * This is the one failure a user can actually fix from the phone (pick
 * another model), so it is surfaced verbatim in the thread instead of
 * being reported as a generic turn failure.
 */
export function modelUnavailableIn(output: string): string | null {
  const match = String(output || '').match(
    /Requested model \S+ is not available for this account\.[^\n]*/,
  );
  return match ? match[0].trim() : null;
}

/**
 * Ceiling on retained per-session queue entries.
 *
 * A queue is created on first contact with a session id and, before this,
 * was never removed -- so a process meant to run for weeks accumulated one
 * entry per session it ever saw. Idle entries are pruned; a running or
 * queued one is never touched.
 */
const MAX_IDLE_QUEUES = 256;

/** Fallback when `execTimeoutMs` arrives unusable. See `armTimeout`. */
export const FALLBACK_EXEC_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The `aside repl` expression that widens a fresh session's permissions.
 *
 * The id is embedded with `JSON.stringify`, not with quotes-and-concat.
 * This was the one place in the codebase building repl code by string
 * interpolation (`'${sessionId}'`), which is the shape that turns into
 * remote code execution against the daemon the day the id stops being a
 * `[A-Za-z0-9_-]` token from a directory name. Every other repl call site
 * already went through a JSON literal; this one now matches.
 *
 * Exported so the escaping is asserted directly.
 */
export function grantFullAccessExpression(sessionId: string): string {
  return `aside.sessions.update(${JSON.stringify(
    sessionId,
  )}, { permissionMode: 'full-access' })`;
}

export class TurnRunner extends EventEmitter {
  private queues = new Map<string, SessionQueue>();
  private pendingNew: InFlightTurn[] = [];
  private spawnFn: typeof spawn;
  /**
   * Session ids a `createSession` discovery has already taken.
   *
   * Two concurrent creates used to pick the same directory -- both took the
   * lexicographically last new name -- so two turns landed on one id and one
   * session's output was attributed to the other. Verified. A claimed id is
   * off the table for any other discovery.
   */
  private claimedIds = new Set<string>();
  /** Create-session children that have no queue entry yet -- see `shutdown`. */
  private pendingChildren = new Set<ChildProcess>();
  /** Serialises discovery, so two creates cannot race over the same window. */
  private createChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RunnerOptions) {
    super();
    this.spawnFn = opts.spawnFn || spawn;
  }

  /** Map a short alias (`sonnet`) onto its full model id. */
  resolveModel(model?: unknown): string {
    const raw = typeof model === 'string' && model.trim() ? model.trim() : '';
    if (!raw) return this.opts.defaultModel;
    return this.opts.modelAliases[raw] || raw;
  }

  resolveEffort(effort?: unknown): EffortLevel {
    return isEffort(effort) ? effort : this.opts.defaultEffort;
  }

  private queueFor(sessionId: string): SessionQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = { running: null, child: null, queued: [] };
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  isBusy(sessionId: string): boolean {
    return Boolean(this.queues.get(sessionId)?.running);
  }

  queuedCount(sessionId: string): number {
    return this.queues.get(sessionId)?.queued.length ?? 0;
  }

  /** Accept a turn. Runs now if the session is idle, otherwise queues. */
  send(sessionId: string, request: TurnRequest): { queued: number } {
    const queue = this.queueFor(sessionId);
    queue.queued.push(request);
    if (!queue.running) this.pump(sessionId);
    return { queued: queue.queued.length };
  }

  private pump(sessionId: string): void {
    const queue = this.queueFor(sessionId);
    if (queue.running || !queue.queued.length) return;

    // Batch adjacent messages that share model + effort, like the bridge's
    // worker does, so quick follow-ups become one turn instead of a stall.
    const head = queue.queued.shift()!;
    const texts = [head.text];
    while (
      queue.queued.length &&
      queue.queued[0].model === head.model &&
      queue.queued[0].effort === head.effort
    ) {
      texts.push(queue.queued.shift()!.text);
    }

    const turn: InFlightTurn = {
      sessionId,
      model: head.model,
      effort: head.effort,
      startedAt: Date.now(),
    };
    queue.running = turn;
    this.emit('turn_started', turn);

    const args = [
      'exec',
      '--session',
      sessionId,
      '-m',
      head.model,
      '--effort',
      head.effort,
      texts.join('\n\n'),
    ];
    const child = this.spawnFn(this.opts.asideCli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    queue.child = child;
    this.trackChild(child, turn, () => {
      queue.running = null;
      queue.child = null;
      this.pump(sessionId);
      this.pruneQueues();
    });
  }

  /**
   * The turn timeout, guaranteed usable.
   *
   * `config.ts` computes this as `Number(raw.exec_timeout_seconds || 1200) *
   * 1000`, which is NaN for any non-numeric value in the bridge config --
   * and `setTimeout(fn, NaN)` fires on the next tick, so every turn was
   * SIGTERM'd the instant it started. Silent, total, and indistinguishable
   * from the CLI failing. Verified.
   */
  private execTimeoutMs(): number {
    const raw = this.opts.execTimeoutMs;
    return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_EXEC_TIMEOUT_MS;
  }

  private trackChild(
    child: ChildProcess,
    turn: InFlightTurn,
    onDone: () => void,
  ): void {
    let stderr = '';
    child.stderr?.on('data', (buf: Buffer) => {
      stderr = (stderr + buf.toString('utf8')).slice(-2000);
    });

    // The daemon reports an unusable model on stdout, not stderr, and
    // often still exits 0. Draining stdout without reading it would
    // swallow the one message that explains why nothing happened.
    //
    // The same stream also carries the answer as it is generated, so it is
    // passed through the prose filter and pushed out as deltas. A turn
    // whose session id is not known yet (a brand new session, mid
    // discovery) simply has nowhere to send them, and they are dropped
    // rather than queued -- the transcript covers that window.
    let stdout = '';
    const prose = new ProseFilter();
    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      stdout = (stdout + text).slice(-4000);
      const delta = prose.feed(text);
      if (delta && turn.sessionId) {
        this.emit('stream_delta', {
          sessionId: turn.sessionId,
          text: delta,
        } satisfies StreamDelta);
      }
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, this.execTimeoutMs());
    timeout.unref?.();

    let settled = false;
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      onDone();
      const payload: TurnFinished = {
        sessionId: turn.sessionId,
        exitCode,
        durationMs: Date.now() - turn.startedAt,
      };
      // Both streams are terminal output; anything surfaced to the user
      // has its escape sequences removed first.
      const cleanOut = stripAnsi(stdout);
      const cleanErr = stripAnsi(stderr);
      const refusal =
        modelUnavailableIn(cleanOut) || modelUnavailableIn(cleanErr);
      if (refusal) {
        payload.error = refusal;
      } else if (error || (exitCode !== 0 && cleanErr.trim())) {
        payload.error = (error || cleanErr.trim()).slice(0, 500);
      }
      this.emit('turn_finished', payload);
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  }

  /**
   * Start a brand new session. The CLI creates the session directory
   * within a second or two of launch, so we watch for a directory that was
   * not there before and hand the id back while the turn keeps running --
   * the client can then subscribe and watch the first reply stream in.
   */
  async createSession(
    request: TurnRequest,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ sessionId: string }> {
    // Discovery is a race against the filesystem, so only one may run at a
    // time. Two overlapping creates otherwise saw the same "new" directory
    // and both claimed it.
    const run = this.createChain.then(
      () => this.createSessionLocked(request, opts),
      () => this.createSessionLocked(request, opts),
    );
    this.createChain = run.catch(() => undefined);
    return run;
  }

  private async createSessionLocked(
    request: TurnRequest,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ sessionId: string }> {
    const before = new Set(this.listSessionDirs());
    const turn: InFlightTurn = {
      sessionId: '',
      model: request.model,
      effort: request.effort,
      startedAt: Date.now(),
      pending: true,
    };
    this.pendingNew.push(turn);

    const child = this.spawnFn(
      this.opts.asideCli,
      [
        'exec',
        '-m',
        request.model,
        '--effort',
        request.effort,
        request.text,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.pendingChildren.add(child);

    let discovered: string | null = null;
    /**
     * Set the moment the child settles.
     *
     * This is the whole fix for a session that came back wedged. The old
     * shape marked the queue `running` AFTER the poll loop, unconditionally
     * -- so a CLI that created its directory and then died before the next
     * 300ms tick had already run its cleanup (with `discovered` still null)
     * by the time we set `running`. Nothing ever cleared it: the session
     * reported busy forever, every later send queued behind a turn that had
     * finished minutes ago, and `/api/status` showed a phantom in flight.
     * Reproduced against this runner.
     */
    let settled = false;
    const dropPending = () => {
      const index = this.pendingNew.indexOf(turn);
      if (index >= 0) this.pendingNew.splice(index, 1);
    };
    const releaseQueue = (sessionId: string) => {
      const queue = this.queueFor(sessionId);
      queue.running = null;
      queue.child = null;
      this.pump(sessionId);
    };

    this.trackChild(child, turn, () => {
      settled = true;
      this.pendingChildren.delete(child);
      dropPending();
      if (discovered) releaseQueue(discovered);
    });

    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    const pollMs = opts.pollMs ?? 300;
    while (Date.now() < deadline) {
      const fresh = this.listSessionDirs()
        .filter((name) => !before.has(name))
        .map((name) => ({ name, id: name.slice(name.lastIndexOf('_') + 1) }))
        // A directory another discovery already took is not ours, and
        // neither is one we are already running a turn against.
        .filter(({ id }) => id && !this.claimedIds.has(id) && !this.isBusy(id));
      if (fresh.length) {
        // Newest wins when several appeared at once; the name carries the
        // date, so a plain sort orders them.
        fresh.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        discovered = fresh[fresh.length - 1].id;
        this.claimedIds.add(discovered);
        break;
      }
      if (child.exitCode !== null || child.signalCode) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (!discovered) {
      dropPending();
      child.kill('SIGTERM');
      throw new Error('could not detect a new session id from the CLI');
    }

    turn.sessionId = discovered;
    turn.pending = false;
    dropPending();

    if (settled) {
      // The child finished while we were still looking for its directory.
      // Its cleanup ran with no id to release, so do that work here rather
      // than marking a finished turn as running.
      this.claimedIds.delete(discovered);
      this.pump(discovered);
      return { sessionId: discovered };
    }

    const queue = this.queueFor(discovered);
    queue.running = turn;
    queue.child = child;
    // Bound: the directory now exists, so the next discovery's "before"
    // snapshot already excludes it and the claim has done its job. The
    // queue now owns the child, so shutdown reaches it that way.
    this.claimedIds.delete(discovered);
    this.pendingChildren.delete(child);
    this.emit('turn_started', turn);

    if (this.opts.grantFullAccess) this.grantFullAccess(discovered);
    return { sessionId: discovered };
  }

  /**
   * New CLI sessions default to guard mode. Off by default here -- the
   * mini app does not silently widen permissions; flip
   * `miniapp_grant_full_access` in the bridge config to opt in.
   */
  private grantFullAccess(sessionId: string): void {
    try {
      const child = this.spawnFn(
        this.opts.asideCli,
        ['repl', grantFullAccessExpression(sessionId)],
        { stdio: 'ignore' },
      );
      child.on('error', () => {});
    } catch {
      // best effort only
    }
  }

  private listSessionDirs(): string[] {
    try {
      return fs
        .readdirSync(this.opts.sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.includes('_'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  status(): { inFlight: InFlightTurn[]; queued: Record<string, number> } {
    const inFlight: InFlightTurn[] = [...this.pendingNew];
    const queued: Record<string, number> = {};
    for (const [sessionId, queue] of this.queues) {
      if (queue.running) inFlight.push(queue.running);
      if (queue.queued.length) queued[sessionId] = queue.queued.length;
    }
    return { inFlight, queued };
  }

  /**
   * Drop idle queue entries once there are more than we want to retain.
   *
   * Called after a turn settles. A queue with work in it is never pruned,
   * so this cannot lose a pending message.
   */
  private pruneQueues(): void {
    if (this.queues.size <= MAX_IDLE_QUEUES) return;
    for (const [sessionId, queue] of this.queues) {
      if (this.queues.size <= MAX_IDLE_QUEUES) return;
      if (queue.running || queue.queued.length) continue;
      this.queues.delete(sessionId);
    }
  }

  /**
   * Stop tracking and kill anything still running (server shutdown).
   *
   * `pendingChildren` matters: a `createSession` whose directory has not
   * appeared yet has no queue entry, so the old loop over `queues` walked
   * straight past it and left an `aside exec` running after the server had
   * gone. Verified.
   */
  shutdown(): void {
    for (const queue of this.queues.values()) {
      queue.queued.length = 0;
      queue.child?.kill('SIGTERM');
    }
    for (const child of this.pendingChildren) child.kill('SIGTERM');
    this.pendingChildren.clear();
  }
}
