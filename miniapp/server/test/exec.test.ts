/**
 * Queue semantics, ported from the bridge's worker: one turn at a time per
 * session, adjacent messages batch, everything else waits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '../src/exec.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.finish(null);
    return true;
  }

  finish(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? -1;
    this.emit('close', code);
  }
}

let env: TestEnv;
let spawned: Array<{ cmd: string; args: string[] }>;
let children: FakeChild[];

function fakeSpawn(): any {
  return (cmd: string, args: string[]) => {
    spawned.push({ cmd, args: [...args] });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
}

function makeRunner(overrides: Record<string, unknown> = {}): TurnRunner {
  return new TurnRunner({
    asideCli: '/fake/aside',
    sessionsDir: env.sessionsDir,
    execTimeoutMs: 5_000,
    defaultModel: 'claude-sonnet-5',
    defaultEffort: 'high',
    modelAliases: { sonnet: 'claude-sonnet-5', fable: 'claude-fable-5' },
    spawnFn: fakeSpawn(),
    ...overrides,
  } as any);
}

beforeEach(() => {
  env = makeTestEnv();
  spawned = [];
  children = [];
});

afterEach(() => env.cleanup());

describe('model and effort resolution', () => {
  it('maps aliases and falls back to config defaults', () => {
    const runner = makeRunner();
    expect(runner.resolveModel('sonnet')).toBe('claude-sonnet-5');
    expect(runner.resolveModel('claude-opus-5')).toBe('claude-opus-5');
    expect(runner.resolveModel(undefined)).toBe('claude-sonnet-5');
    expect(runner.resolveEffort('xhigh')).toBe('xhigh');
    expect(runner.resolveEffort('nonsense')).toBe('high');
    expect(runner.resolveEffort(undefined)).toBe('high');
  });
});

describe('per-session serialisation', () => {
  it('runs one turn at a time and queues the rest', () => {
    const runner = makeRunner();
    runner.send('sessA', { text: 'first', model: 'm', effort: 'low' });
    expect(spawned).toHaveLength(1);
    expect(runner.isBusy('sessA')).toBe(true);

    runner.send('sessA', { text: 'second', model: 'other', effort: 'low' });
    expect(spawned).toHaveLength(1); // still queued behind the first
    expect(runner.queuedCount('sessA')).toBe(1);

    children[0].finish(0);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toContain('second');
  });

  it('batches adjacent queued messages that share model and effort', () => {
    const runner = makeRunner();
    runner.send('sessA', { text: 'first', model: 'm', effort: 'low' });
    runner.send('sessA', { text: 'second', model: 'm', effort: 'low' });
    runner.send('sessA', { text: 'third', model: 'm', effort: 'low' });
    children[0].finish(0);

    expect(spawned).toHaveLength(2);
    expect(spawned[1].args.at(-1)).toBe('second\n\nthird');
  });

  it('does not batch across a model or effort change', () => {
    const runner = makeRunner();
    runner.send('sessA', { text: 'one', model: 'm', effort: 'low' });
    runner.send('sessA', { text: 'two', model: 'm', effort: 'low' });
    runner.send('sessA', { text: 'three', model: 'm', effort: 'high' });
    children[0].finish(0);

    expect(spawned[1].args.at(-1)).toBe('two');
    children[1].finish(0);
    expect(spawned[2].args.at(-1)).toBe('three');
  });

  it('keeps separate sessions independent', () => {
    const runner = makeRunner();
    runner.send('sessA', { text: 'a', model: 'm', effort: 'low' });
    runner.send('sessB', { text: 'b', model: 'm', effort: 'low' });
    expect(spawned).toHaveLength(2);
    expect(runner.isBusy('sessA')).toBe(true);
    expect(runner.isBusy('sessB')).toBe(true);
  });

  it('passes argv as an array so prompt text needs no quoting', () => {
    const runner = makeRunner();
    runner.send('sessA', {
      text: 'weird "quotes" and $(rm -rf /) and \'ticks\'',
      model: 'claude-sonnet-5',
      effort: 'low',
    });
    expect(spawned[0].cmd).toBe('/fake/aside');
    expect(spawned[0].args).toEqual([
      'exec',
      '--session',
      'sessA',
      '-m',
      'claude-sonnet-5',
      '--effort',
      'low',
      // End-of-options, so a prompt that begins with a dash reaches the
      // agent instead of being parsed as a flag. See `PROMPT_TERMINATOR`.
      '--',
      'weird "quotes" and $(rm -rf /) and \'ticks\'',
    ]);
  });
});

describe('turn lifecycle events', () => {
  it('emits turn_started and turn_finished with the exit code', async () => {
    const runner = makeRunner();
    const events: any[] = [];
    runner.on('turn_started', (t) => events.push(['started', t.sessionId]));
    runner.on('turn_finished', (t) => events.push(['finished', t.exitCode]));

    runner.send('sessA', { text: 'go', model: 'm', effort: 'low' });
    children[0].finish(0);
    expect(events).toEqual([
      ['started', 'sessA'],
      ['finished', 0],
    ]);
  });

  it('surfaces stderr on a failing turn', async () => {
    const runner = makeRunner();
    const finished = new Promise<any>((resolve) =>
      runner.once('turn_finished', resolve),
    );
    runner.send('sessA', { text: 'go', model: 'm', effort: 'low' });
    children[0].stderr.write('aside: session is busy\n');
    await new Promise((r) => setImmediate(r));
    children[0].finish(1);
    const payload = await finished;
    expect(payload.exitCode).toBe(1);
    expect(payload.error).toContain('session is busy');
  });

  it('reports in-flight turns via status()', () => {
    const runner = makeRunner();
    runner.send('sessA', { text: 'go', model: 'claude-sonnet-5', effort: 'low' });
    runner.send('sessA', { text: 'later', model: 'x', effort: 'low' });
    const status = runner.status();
    expect(status.inFlight.map((t) => t.sessionId)).toEqual(['sessA']);
    expect(status.queued).toEqual({ sessA: 1 });
  });
});

describe('new session creation', () => {
  it('returns the id of the session directory the CLI creates', async () => {
    const runner = makeRunner();
    const promise = runner.createSession(
      { text: 'hello', model: 'claude-sonnet-5', effort: 'low' },
      { timeoutMs: 3_000, pollMs: 20 },
    );
    setTimeout(() => {
      fs.mkdirSync(path.join(env.sessionsDir, '2026-02-01_brandNewSess'));
    }, 60);

    const { sessionId } = await promise;
    expect(sessionId).toBe('brandNewSess');
    expect(spawned[0].args).toEqual([
      'exec',
      '-m',
      'claude-sonnet-5',
      '--effort',
      'low',
      '--',
      'hello',
    ]);
    expect(spawned[0].args).not.toContain('--session');
    expect(runner.isBusy('brandNewSess')).toBe(true);
  });

  it('fails cleanly when no session directory ever appears', async () => {
    const runner = makeRunner();
    await expect(
      runner.createSession(
        { text: 'hello', model: 'm', effort: 'low' },
        { timeoutMs: 200, pollMs: 20 },
      ),
    ).rejects.toThrow(/could not detect a new session id/);
    expect(children[0].killed).toBe(true);
  });
});
