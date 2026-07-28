/**
 * Round 5: subagent cards, file diffs, token counters, citations, files.
 *
 * The tests that matter here are the joins and the guards -- the spawn ->
 * child match by toolCallId, the artifact path containment, the diff
 * parsing -- because each of those is a place where a plausible-looking
 * wrong answer would ship silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper shared with the dev harness
import { buildInitDataFields, signInitData } from '../../scripts/sign-initdata.mjs';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import {
  FAKE_BOT_TOKEN,
  OWNER_ID,
  defaultFixtureRows,
  makeTestEnv,
  type TestEnv,
} from './helpers.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  buildCatalog,
  contextWindowFor,
} from '../src/catalog.js';
import {
  attachChildren,
  buildThread,
  fileEditFrom,
  labelFor,
  parseDiffLines,
  spawnFrom,
  threadStats,
  workSteps,
  type ChildSession,
  type ThreadItem,
} from '../src/thread.js';
import { collectSources, domainOf } from '../src/sources.js';
import {
  artifactContentType,
  artifactKind,
  listArtifacts,
  resolveArtifact,
} from '../src/artifacts.js';
import { SubagentIndex, isRunning, toChildSession } from '../src/subagents.js';
import { triggerToolCallId } from '../src/statedb.js';
import { readHistory } from '../src/jsonl.js';

/** The fixture parent that has search sources, a file write and citations. */
const DDDD = {
  id: 'fixtureDDDD',
  title: 'Research the launch',
  trigger: JSON.stringify({ type: 'user', source: 'sidepanel' }),
  status: 'idle',
  readAt: 1767657700,
  createdAt: 1767657600,
  updatedAt: 1767657605,
  permissionMode: 'guard',
  model: JSON.stringify({
    provider: 'claude-code',
    modelId: 'claude-fable-5',
    thinkingLevel: 'high',
  }),
};

let env: TestEnv;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  env = makeTestEnv({ __stateRows: [...defaultFixtureRows(), DDDD] });
  const config = loadConfig();
  const built = await buildServer(config, {
    jwtSecret: loadOrCreateJwtSecret(env.secretPath),
  });
  app = built.app;
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth',
    payload: {
      initDataRaw: signInitData(
        buildInitDataFields({ userId: OWNER_ID, platform: 'ios' }),
        FAKE_BOT_TOKEN,
      ),
    },
  });
  token = res.json().token as string;
});

afterEach(async () => {
  await app.close();
  env.cleanup();
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe('context window', () => {
  const catalog = buildCatalog(['claude-code']);

  it('gives Fable 5 a million tokens and the rest the default', () => {
    expect(contextWindowFor(catalog, 'claude-code', 'claude-fable-5')).toBe(
      1_000_000,
    );
    expect(contextWindowFor(catalog, 'claude-code', 'claude-sonnet-5')).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });

  it('falls back to the default for a model it has never heard of', () => {
    expect(contextWindowFor(catalog, 'nope', 'nope')).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });

  it('takes a window from config, and keeps the built-in one on a rename', () => {
    const overridden = buildCatalog(['claude-code'], {
      'claude-code': {
        models: [
          { id: 'claude-sonnet-5', contextWindow: 500_000 },
          { id: 'claude-fable-5', label: 'Fable Five' },
        ],
      },
    });
    expect(contextWindowFor(overridden, 'claude-code', 'claude-sonnet-5')).toBe(
      500_000,
    );
    // The rename must not silently reset Fable's window to the default.
    expect(contextWindowFor(overridden, 'claude-code', 'claude-fable-5')).toBe(
      1_000_000,
    );
  });

  it('reports the session model’s window on the thread endpoint', async () => {
    const body = (await get('/api/sessions/fixtureDDDD/thread')).json();
    expect(body.contextWindow).toBe(1_000_000);
    // The last assistant message's usage.totalTokens is the ring's numerator.
    expect(body.stats.totalTokens).toBe(1600);
  });
});

describe('turn token counters', () => {
  it('accumulates output and reasoning since the last user message', () => {
    const stats = threadStats(
      readHistory(path.join(env.sessionsDir, '2026-01-06_fixtureDDDD/messages.jsonl')),
    );
    // 120+30, 90, 140+10 -- every assistant message of the single turn.
    expect(stats.turnTokens).toBe(390);
    expect(stats.turnStartedAt).toBe(1767657601000);
  });

  it('resets at each user message rather than summing the session', () => {
    const stats = threadStats([
      { role: 'assistant', content: [], usage: { output: 100, totalTokens: 900 } },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: [], usage: { output: 7, totalTokens: 950 } },
    ]);
    expect(stats.turnTokens).toBe(7);
    expect(stats.totalTokens).toBe(950);
  });
});

describe('file write and edit cards', () => {
  it('numbers a unified diff from the + side of each hunk', () => {
    expect(
      parseDiffLines('@@ -3 +3,3 @@\n-gone\n+one\n two\n+three'),
    ).toEqual([
      { n: null, kind: 'del', text: 'gone' },
      { n: 3, kind: 'add', text: 'one' },
      { n: 4, kind: 'ctx', text: 'two' },
      { n: 5, kind: 'add', text: 'three' },
    ]);
  });

  it('builds a write card from the content, numbered from one', () => {
    const card = fileEditFrom(
      'write_file',
      { file_path: '/tmp/a/notes.md', content: '# Notes\n\n- one' },
      undefined,
    )!;
    expect(card.mode).toBe('write');
    expect(card.name).toBe('notes.md');
    expect(card.lines).toEqual([
      { n: 1, kind: 'add', text: '# Notes' },
      { n: 2, kind: 'add', text: '' },
      { n: 3, kind: 'add', text: '- one' },
    ]);
  });

  it('uses an edit’s requested text before the result, and the diff after', () => {
    const args = {
      path: '/tmp/a/SOUL.md',
      edits: [{ oldText: 'old', newText: 'new' }],
    };
    expect(fileEditFrom('edit_file', args, undefined)!.lines).toEqual([
      { n: null, kind: 'del', text: 'old' },
      { n: 1, kind: 'add', text: 'new' },
    ]);
    expect(
      fileEditFrom('edit_file', args, { diff: '@@ -9 +9 @@\n-old\n+new' })!.lines,
    ).toEqual([
      { n: null, kind: 'del', text: 'old' },
      { n: 9, kind: 'add', text: 'new' },
    ]);
  });

  it('attaches no card to tools that do not touch files', () => {
    expect(fileEditFrom('bash', { command: 'ls' }, undefined)).toBeNull();
  });

  it('carries the card on the built thread’s write step', () => {
    const items = buildThread(
      readHistory(path.join(env.sessionsDir, '2026-01-06_fixtureDDDD/messages.jsonl')),
    );
    const write = workSteps(items).find((step) => step.tool === 'write_file')!;
    expect(write.file?.name).toBe('notes.md');
    expect(write.file?.lines.length).toBe(4);
    expect(write.diffstat).toEqual({ added: 4, removed: 0 });
  });
});

describe('step labels', () => {
  it('quotes a web search’s objective, which is the argument the tool takes', () => {
    expect(
      labelFor('websearch', { objective: 'Latest AI model releases' }, undefined),
    ).toBe('Searched “Latest AI model releases”');
    expect(labelFor('websearch', {}, undefined)).toBe('Searched the web');
  });

  it('prefixes a subagent spawn with the verb, as the sidepanel does', () => {
    expect(
      labelFor('subagent', { action: 'spawn', description: 'Audit' }, undefined),
    ).toBe('Spawned Audit');
  });
});

describe('subagent spawns and their child sessions', () => {
  it('recognises a spawn and ignores the tool’s other actions', () => {
    expect(
      spawnFrom('subagent', 'call-1', {
        action: 'spawn',
        description: 'Audit',
        prompt: 'Look at the loader\nand report',
      }),
    ).toEqual({
      callId: 'call-1',
      description: 'Audit',
      prompt: 'Look at the loader',
      hue: 0,
    });
    expect(spawnFrom('subagent', 'call-1', { action: 'cancel' })).toBeNull();
    expect(spawnFrom('bash', 'call-1', { description: 'x' })).toBeNull();
  });

  it('joins a spawn to its child by toolCallId, not by title', () => {
    const items = buildThread(
      readHistory(path.join(env.sessionsDir, '2026-01-03_fixtureBBBB/messages.jsonl')),
    );
    const child: ChildSession = {
      id: 'subagentKid',
      title: 'Audit the config loader',
      status: 'running',
      toolCallId: 'toolu_spawn_one',
      modelLabel: 'Sonnet 5',
      running: true,
    };
    attachChildren(items, [child]);
    const spawn = workSteps(items).find((step) => step.subagent)!.subagent!;
    expect(spawn.child?.id).toBe('subagentKid');
  });

  it('reads the join key out of the trigger, and survives a malformed one', () => {
    expect(
      triggerToolCallId(JSON.stringify({ type: 'subagent', toolCallId: 'c9' })),
    ).toBe('c9');
    expect(triggerToolCallId(JSON.stringify({ type: 'user' }))).toBe('');
    expect(triggerToolCallId('{not json')).toBe('');
    expect(triggerToolCallId(null)).toBe('');
  });

  it('leaves a spawn unjoined when no child claims its call', () => {
    const items = buildThread(
      readHistory(path.join(env.sessionsDir, '2026-01-03_fixtureBBBB/messages.jsonl')),
    );
    attachChildren(items, [
      {
        id: 'someoneElse',
        title: 'Audit the config loader',
        status: 'idle',
        toolCallId: 'toolu_a_different_call',
        modelLabel: null,
        running: false,
      },
    ]);
    expect(workSteps(items).find((s) => s.subagent)!.subagent!.child).toBeUndefined();
  });

  it('reads children out of the daemon table with their model', async () => {
    const body = (await get('/api/sessions/fixtureBBBB/thread')).json();
    expect(body.subagents).toEqual([
      {
        id: 'subagentKid',
        title: 'Audit the config loader',
        status: 'running',
        toolCallId: 'toolu_spawn_one',
        modelLabel: 'Sonnet 5',
        running: true,
        hue: 0,
      },
    ]);
  });

  it('sends the child’s own timeline with the thread', async () => {
    const body = (await get('/api/sessions/fixtureBBBB/thread')).json();
    expect(body.subagentSteps).toHaveLength(1);
    const [entry] = body.subagentSteps;
    expect(entry.childId).toBe('subagentKid');
    expect(entry.total).toBe(2);
    expect(entry.steps.map((s: { label: string }) => s.label)).toEqual([
      'Read config.ts',
      'Run the loader tests',
    ]);
    // The second call has no result in the fixture, so it is still in flight.
    expect(entry.steps[1].status).toBe('pending');
  });

  it('treats only `running` as running', () => {
    expect(isRunning('running')).toBe(true);
    expect(isRunning('idle')).toBe(false);
    expect(
      toChildSession(
        {
          id: 'x',
          title: '',
          status: 'idle',
          toolCallId: 'c',
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
        () => 'ignored',
      ),
    ).toEqual({
      id: 'x',
      // An untitled child still needs something to render.
      title: 'Subagent',
      status: 'idle',
      toolCallId: 'c',
      modelLabel: null,
      running: false,
    });
  });
});

describe('a fold only reads as running while its turn really is', () => {
  const spawnTurn = [
    { role: 'user', content: 'go', timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }],
      timestamp: 2,
    },
    { role: 'assistant', content: [{ type: 'text', text: 'all done' }], timestamp: 3 },
  ];

  it('settles a fold whose turn already produced its answer', () => {
    // `running` is true here: this is the window between a send being
    // accepted and the new user message reaching the transcript, where the
    // previous turn's fold used to flash back open with a spinner.
    const items = buildThread(spawnTurn, true);
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'answer']);
    expect((items[1] as { running: boolean }).running).toBe(false);
  });

  it('keeps a fold running while the turn has produced no answer yet', () => {
    const items = buildThread(spawnTurn.slice(0, 2), true);
    expect((items[1] as { running: boolean }).running).toBe(true);
  });
});

describe('SubagentIndex', () => {
  const child = (status: string): ChildSession => ({
    id: 'kid',
    title: 'Kid',
    status,
    toolCallId: 'c1',
    modelLabel: null,
    running: status === 'running',
  });

  it('serves an empty snapshot before the first read, then the real one', async () => {
    const index = new SubagentIndex(async () => [child('running')]);
    expect(index.snapshot('p').children).toEqual([]);
    await index.refresh('p');
    expect(index.snapshot('p').children).toEqual([child('running')]);
  });

  it('announces a change once, and stays quiet when nothing moved', async () => {
    let status = 'running';
    const index = new SubagentIndex(async () => [child(status)]);
    const seen: string[] = [];
    index.on('updated', (id: string) => seen.push(id));

    await index.refresh('p');
    await index.refresh('p');
    expect(seen).toEqual(['p']);

    status = 'idle';
    await index.refresh('p');
    expect(seen).toEqual(['p', 'p']);
    expect(index.snapshot('p').children[0].running).toBe(false);
  });

  /**
   * A session that has never spawned anything looks settled, so without the
   * parent's own busy state the first spawn of a turn waits out the long
   * TTL. Caught on a live run: two subagents came and went unseen.
   */
  it('re-reads quickly while the parent is busy, even with no children yet', async () => {
    let reads = 0;
    let now = 0;
    const index = new SubagentIndex(
      async () => {
        reads += 1;
        return [];
      },
      () => now,
    );

    await index.refresh('p');
    expect(reads).toBe(1);

    now = 5_000;
    index.snapshot('p', false);
    expect(reads).toBe(1); // settled: the long TTL has not expired

    index.snapshot('p', true);
    await Promise.resolve();
    expect(reads).toBe(2);
  });

  it('keeps the last good snapshot when the database goes unreadable', async () => {
    let answer: ChildSession[] | null = [child('running')];
    const index = new SubagentIndex(async () => answer);
    await index.refresh('p');
    answer = null;
    await index.refresh('p');
    expect(index.snapshot('p').children).toEqual([child('running')]);
  });
});

describe('citation sources', () => {
  it('collects search results by source id', () => {
    const sources = collectSources(
      readHistory(path.join(env.sessionsDir, '2026-01-06_fixtureDDDD/messages.jsonl')),
    );
    expect(sources.srcAAA).toEqual({
      id: 'srcAAA',
      url: 'https://example.com/a/launch',
      title: 'The launch, explained',
      domain: 'example.com',
      excerpt: 'It shipped on a Tuesday.',
    });
    // The answer also cites `s1`, which is a local marker, not a source.
    expect(sources.s1).toBeUndefined();
  });

  it('strips www and survives a malformed url', () => {
    expect(domainOf('https://www.reddit.com/r/x')).toBe('reddit.com');
    expect(domainOf('not a url')).toBe('');
  });

  it('serves the catalog with the thread', async () => {
    const body = (await get('/api/sessions/fixtureDDDD/thread')).json();
    expect(Object.keys(body.sources)).toEqual(['srcAAA']);
  });

  /**
   * The case that made this necessary: a session that delegates research
   * has no sources of its own, but its answer cites the ones its subagents
   * found. Resolving against the parent alone suppresses every chip.
   */
  it('resolves sources its subagents found, not just its own', async () => {
    const kidFile = path.join(
      env.sessionsDir,
      '2026-01-03_subagentKid/messages.jsonl',
    );
    fs.appendFileSync(
      kidFile,
      `${JSON.stringify({
        role: 'toolResult',
        toolCallId: 'kid_call_3',
        toolName: 'websearch',
        content: [{ type: 'text', text: '{}' }],
        details: {
          sources: [
            { id: 'kidSrc', url: 'https://kid.example/x', title: 'Kid source' },
          ],
        },
        timestamp: 1767398405,
      })}\n`,
    );

    const body = (await get('/api/sessions/fixtureBBBB/thread')).json();
    expect(body.sources.kidSrc?.domain).toBe('kid.example');
  });
});

describe('session artifacts', () => {
  const dir = () =>
    path.join(env.sessionsDir, '2026-01-06_fixtureDDDD');

  it('lists both groups recursively with kinds', () => {
    expect(listArtifacts(dir(), 'artifacts')).toEqual([
      expect.objectContaining({
        path: '2026-01-06/notes.md',
        name: 'notes.md',
        kind: 'markdown',
      }),
    ]);
    expect(listArtifacts(dir(), 'attachments')).toEqual([
      expect.objectContaining({ path: 'note.txt', kind: 'text' }),
    ]);
  });

  it('reports an empty list for a session with no artifacts dir', () => {
    expect(
      listArtifacts(path.join(env.sessionsDir, '2026-01-02_fixtureAAAA'), 'artifacts'),
    ).toEqual([]);
  });

  it('classifies and types files by extension, defaulting to opaque', () => {
    expect(artifactKind('a.png')).toBe('image');
    expect(artifactKind('a.ts')).toBe('code');
    expect(artifactKind('a.bin')).toBe('binary');
    expect(artifactContentType('a.md')).toBe('text/markdown; charset=utf-8');
    expect(artifactContentType('a.png')).toBe('image/png');
    // Never guessed: an unknown type must not become text/html.
    expect(artifactContentType('a.weird')).toBe('application/octet-stream');
  });

  it('refuses to resolve a path outside the group directory', () => {
    expect(resolveArtifact(dir(), 'artifacts', '2026-01-06/notes.md')).toContain(
      'notes.md',
    );
    expect(resolveArtifact(dir(), 'artifacts', '../messages.jsonl')).toBeNull();
    expect(resolveArtifact(dir(), 'artifacts', '../../../../etc/hosts')).toBeNull();
    expect(resolveArtifact(dir(), 'artifacts', '/etc/hosts')).toBeNull();
    expect(resolveArtifact(dir(), 'artifacts', '')).toBeNull();
  });

  it('refuses a symlink that escapes, even though the path looks inside', () => {
    const link = path.join(dir(), 'artifacts', 'escape.md');
    fs.symlinkSync(path.join(dir(), 'messages.jsonl'), link);
    expect(resolveArtifact(dir(), 'artifacts', 'escape.md')).toBeNull();
    // And it is not offered in the listing either.
    expect(
      listArtifacts(dir(), 'artifacts').some((f) => f.name === 'escape.md'),
    ).toBe(false);
  });

  it('serves a file over HTTP and 403s a traversal', async () => {
    const ok = await get(
      '/api/sessions/fixtureDDDD/artifacts/file?group=artifacts&path=2026-01-06%2Fnotes.md',
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(ok.body).toContain('# Notes');

    const bad = await get(
      '/api/sessions/fixtureDDDD/artifacts/file?group=artifacts&path=..%2Fmessages.jsonl',
    );
    expect(bad.statusCode).toBe(403);
  });

  it('requires a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/fixtureDDDD/artifacts',
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the token as a query param on the file route only', async () => {
    const viaQuery = await app.inject({
      method: 'GET',
      url: `/api/sessions/fixtureDDDD/artifacts/file?group=artifacts&path=2026-01-06%2Fnotes.md&token=${token}`,
    });
    expect(viaQuery.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'GET',
      url: `/api/sessions/fixtureDDDD/artifacts/file?group=artifacts&path=2026-01-06%2Fnotes.md&token=nope`,
    });
    expect(rejected.statusCode).toBe(401);
  });
});

describe('thread items still carry what round 4 promised', () => {
  it('keeps folds, answers and bubbles unchanged for the new fixture', async () => {
    const body = (await get('/api/sessions/fixtureDDDD/thread')).json();
    const kinds = (body.items as ThreadItem[]).map((item) => item.kind);
    expect(kinds).toEqual(['user', 'work', 'answer']);
  });
});
