/**
 * The facade transport and the thread model built on top of it.
 *
 * The fixtures below are trimmed from real `aside repl` output, including
 * the CLI's ANSI `[ok | 12ms]` trailer -- the exact thing that makes raw
 * stdout unparseable and the sentinels necessary.
 */
import { describe, expect, it } from 'vitest';
import {
  FacadeCache,
  FacadeError,
  fetchDefaultModel,
  parseFacadeOutput,
} from '../src/facade.js';
import { buildThread, diffstatOf, iconFor, labelFor } from '../src/thread.js';
import { EFFORT_LABELS, EFFORT_MENU, effortLabel } from '../src/config.js';
import { modelUnavailableIn } from '../src/exec.js';

const OK_TRAILER = '[2m[ok | 9ms][0m\n';

describe('parseFacadeOutput', () => {
  it('extracts the payload from around the CLI trailer', () => {
    const rows = [{ id: 'abc', title: 'Hello' }];
    const stdout = `<<<ASIDE_JSON${JSON.stringify(rows)}ASIDE_JSON>>>\n${OK_TRAILER}`;
    expect(parseFacadeOutput(stdout)).toEqual(rows);
  });

  it('survives daemon chatter printed before the payload', () => {
    const stdout = `some warning\n<<<ASIDE_JSON{"a":1}ASIDE_JSON>>>\n${OK_TRAILER}`;
    expect(parseFacadeOutput(stdout)).toEqual({ a: 1 });
  });

  it('throws when the CLI printed no payload at all', () => {
    expect(() => parseFacadeOutput(OK_TRAILER)).toThrow(/no payload/);
  });

  it('throws on a malformed payload rather than returning junk', () => {
    expect(() =>
      parseFacadeOutput('<<<ASIDE_JSON{oops}ASIDE_JSON>>>'),
    ).toThrow(/not JSON/);
  });
});

describe('FacadeCache', () => {
  /** A cache whose "CLI" is a call counter. */
  function makeCache(now: () => number) {
    let calls = 0;
    const cache = new FacadeCache(
      {
        asideCli: '/unused',
        runFn: async () => {
          calls += 1;
          return calls;
        },
      },
      now,
    );
    return { cache, calls: () => calls };
  }

  it('serves within the TTL and refetches after it', async () => {
    let now = 1000;
    const { cache, calls } = makeCache(() => now);

    expect(await cache.call('k', 'expr', 1000)).toBe(1);
    expect(await cache.call('k', 'expr', 1000)).toBe(1);
    expect(calls()).toBe(1);

    now += 1500;
    expect(await cache.call('k', 'expr', 1000)).toBe(2);
    expect(calls()).toBe(2);
  });

  it('coalesces concurrent calls for the same key into one spawn', async () => {
    const { cache, calls } = makeCache(() => 0);
    const results = await Promise.all([
      cache.call('k', 'expr', 1000),
      cache.call('k', 'expr', 1000),
      cache.call('k', 'expr', 1000),
    ]);
    expect(results).toEqual([1, 1, 1]);
    expect(calls()).toBe(1);
  });

  it('keys separately, so different reads do not collide', async () => {
    const { cache, calls } = makeCache(() => 0);
    await cache.call('a', 'expr-a', 1000);
    await cache.call('b', 'expr-b', 1000);
    expect(calls()).toBe(2);
  });

  it('never serves a mutation from cache', async () => {
    const { cache, calls } = makeCache(() => 0);
    await cache.mutate('markRead');
    await cache.mutate('markRead');
    expect(calls()).toBe(2);
  });

  it('invalidate() forces the next read to refetch', async () => {
    const { cache, calls } = makeCache(() => 0);
    await cache.call('k', 'expr', 10_000);
    cache.invalidate('k');
    await cache.call('k', 'expr', 10_000);
    expect(calls()).toBe(2);
  });
});

describe('effort levels', () => {
  it('uses Aside’s own labels', () => {
    expect(EFFORT_LABELS).toMatchObject({
      off: 'Off',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra High',
      max: 'Max',
      ultrabrowse: 'Ultrabrowse',
    });
    expect(effortLabel('xhigh')).toBe('Extra High');
    expect(effortLabel('weird')).toBe('weird');
  });

  it('omits Max from the menu because the CLI rejects it', () => {
    // Verified against the binary: `aside exec --effort max` fails with
    // "Allowed choices are off, minimal, low, medium, high, xhigh,
    // ultrabrowse."
    expect(EFFORT_MENU).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'ultrabrowse',
    ]);
    expect(EFFORT_MENU).not.toContain('max');
    // Off/Minimal stay accepted by the API even though Aside hides them.
    expect(EFFORT_LABELS.off).toBe('Off');
  });
});

describe('step labels and icons', () => {
  it('prefers the tool’s own title', () => {
    expect(
      labelFor('bash', { title: 'Checking Orca repo options', command: 'ls' }, {}),
    ).toBe('Checking Orca repo options');
  });

  it('derives a label per tool when there is no title', () => {
    expect(labelFor('write_file', { file_path: '/a/b/spec.md' }, {})).toBe(
      'Wrote spec.md',
    );
    expect(labelFor('read_file', { path: '/a/b/notes.md' }, {})).toBe(
      'Read notes.md',
    );
    expect(
      labelFor('read_file', { path: '/x' }, { skillName: 'orca-delegation' }),
    ).toBe('Read the orca-delegation skill');
    expect(labelFor('memory_search', {}, {})).toBe('Searched memory');
    expect(labelFor('unknown_tool', {}, {})).toBe('unknown_tool');
  });

  it('maps tools onto the monochrome icon set', () => {
    expect(iconFor('bash')).toBe('terminal');
    expect(iconFor('repl')).toBe('globe');
    expect(iconFor('write_file')).toBe('file');
    expect(iconFor('websearch')).toBe('search');
    expect(iconFor('mystery')).toBe('dot');
  });

  it('counts a diffstat without miscounting hunk headers', () => {
    const diff = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,4 @@',
      '-old line',
      '+new line',
      '+another',
      ' context',
    ].join('\n');
    expect(diffstatOf(diff)).toEqual({ added: 2, removed: 1 });
  });
});

describe('buildThread', () => {
  const transcript = [
    { role: 'system-message', content: 'skills available', timestamp: 1 },
    { role: 'user', content: 'Build the thing', timestamp: 1000 },
    {
      role: 'assistant',
      timestamp: 2000,
      content: [
        { type: 'thinking', thinking: 'never rendered' },
        { type: 'text', text: 'Starting now.' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'bash',
          arguments: { title: 'Cloning the repo', command: 'git clone x' },
        },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      details: { runtime: 'local-bash', exitCode: 0 },
      content: [{ type: 'text', text: 'Cloned.' }],
      timestamp: 3000,
    },
    {
      role: 'assistant',
      timestamp: 4000,
      content: [
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'edit_file',
          arguments: { file_path: '/repo/app.ts' },
        },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'edit_file',
      isError: false,
      details: { diff: '@@ -1 +1,3 @@\n-a\n+b\n+c' },
      content: [{ type: 'text', text: 'Edited.' }],
      timestamp: 5000,
    },
    {
      role: 'assistant',
      timestamp: 100_000,
      content: [{ type: 'text', text: '## Done\nAll finished.' }],
    },
  ];

  it('produces one fold plus the final answer, as the sidepanel does', () => {
    const items = buildThread(transcript as any);
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'answer']);

    const answer = items[2] as any;
    expect(answer.text).toBe('## Done\nAll finished.');
  });

  it('keeps mid-turn commentary inside the fold, not as the answer', () => {
    const work = buildThread(transcript as any)[1] as any;
    const texts = work.items.filter((i: any) => i.kind === 'text');
    expect(texts.map((t: any) => t.text)).toEqual(['Starting now.']);
  });

  it('never surfaces thinking parts', () => {
    const work = buildThread(transcript as any)[1] as any;
    const blob = JSON.stringify(work);
    expect(blob).not.toContain('never rendered');
  });

  it('attaches status, diffstat and detail to each step', () => {
    const work = buildThread(transcript as any)[1] as any;
    const steps = work.items.filter((i: any) => i.kind === 'step');

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      icon: 'terminal',
      label: 'Cloning the repo',
      status: 'success',
    });
    expect(steps[0].detail.command).toBe('git clone x');
    expect(steps[0].detail.output).toBe('Cloned.');

    expect(steps[1]).toMatchObject({
      icon: 'file',
      label: 'Edited app.ts',
      diffstat: { added: 2, removed: 1 },
    });
  });

  it('emits no per-step timestamps', () => {
    const work = buildThread(transcript as any)[1] as any;
    for (const step of work.items) {
      expect(step).not.toHaveProperty('ts');
      expect(step).not.toHaveProperty('offset');
    }
  });

  it('measures the turn duration for the fold row', () => {
    const work = buildThread(transcript as any)[1] as any;
    // First assistant timestamp through the last activity of the turn.
    expect(work.durationMs).toBe(98_000);
  });

  it('marks a live turn as running', () => {
    // A live turn is one that has not written its answer yet -- once the
    // answer is on disk the fold is finished even if the session is busy
    // again, so the fixture stops before that last message.
    const running = buildThread(transcript.slice(0, -1) as any, true);
    const work = running.find((i) => i.kind === 'work') as any;
    expect(work.running).toBe(true);
  });

  it('flags a failed tool call as an error', () => {
    const failed = buildThread([
      { role: 'user', content: 'go', timestamp: 1 },
      {
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'x' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
        timestamp: 3,
      },
    ] as any);
    const work = failed.find((i) => i.kind === 'work') as any;
    expect(work.items[0].status).toBe('error');
  });

  it('turns image results into inline data URLs', () => {
    const withImage = buildThread([
      { role: 'user', content: 'shot', timestamp: 1 },
      {
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'toolCall', id: 'c', name: 'repl', arguments: { title: 'Browsing' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'repl',
        isError: false,
        content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }],
        timestamp: 3,
      },
    ] as any);
    const work = withImage.find((i) => i.kind === 'work') as any;
    expect(work.items[0].images).toEqual(['data:image/jpeg;base64,QUJD']);
  });

  it('handles an empty transcript', () => {
    expect(buildThread([])).toEqual([]);
  });
});

describe('modelUnavailableIn', () => {
  it('recognises the daemon’s notice on stdout', () => {
    const out =
      'starting…\nRequested model openai-codex/gpt-9 is not available for ' +
      'this account. Connect the provider or choose an available model.\n';
    expect(modelUnavailableIn(out)).toBe(
      'Requested model openai-codex/gpt-9 is not available for this account. ' +
        'Connect the provider or choose an available model.',
    );
  });

  it('stays quiet on ordinary output', () => {
    expect(modelUnavailableIn('all good')).toBeNull();
    expect(modelUnavailableIn('')).toBeNull();
  });
});

/**
 * The daemon's account-wide default model.
 *
 * This drives the home screen's pills when the user has made no explicit
 * pick, so getting it wrong means the app confidently displays a model the
 * next turn will not use. It had no coverage at all until round 4, when a
 * browser check reported `/api/status` returning a null default -- that
 * turned out to be a read of `.default` rather than `.defaults`, but the
 * absence of a test meant it took a live daemon to establish that.
 */
describe('fetchDefaultModel', () => {
  /** Exactly what `aside.settings.getAll().defaultModel` returns live. */
  const LIVE_SHAPE = {
    provider: 'claude-code',
    modelId: 'claude-fable-5',
    thinkingLevel: 'high',
    fastMode: false,
  };

  it('reads the settings payload the daemon actually returns', async () => {
    const cache = new FacadeCache({
      asideCli: '/bin/false',
      runFn: async () => LIVE_SHAPE,
    });
    expect(await fetchDefaultModel(cache)).toEqual(LIVE_SHAPE);
  });

  /**
   * `getAll()` is synchronous on the live daemon, so the expression reads
   * `.defaultModel` off it directly. If that ever became async the property
   * read would land on a Promise and yield undefined -- so the expression
   * is pinned here rather than left to drift silently.
   */
  it('asks for the settings key by its real name', async () => {
    const seen: string[] = [];
    const cache = new FacadeCache({
      asideCli: '/bin/false',
      runFn: async (expression) => {
        seen.push(expression);
        return LIVE_SHAPE;
      },
    });
    await fetchDefaultModel(cache);
    expect(seen).toEqual(['aside.settings.getAll().defaultModel']);
  });

  it('reports null rather than guessing when settings are unreadable', async () => {
    const cache = new FacadeCache({
      asideCli: '/bin/false',
      runFn: async () => null,
    });
    expect(await fetchDefaultModel(cache)).toBeNull();
  });

  it('propagates a facade failure instead of inventing a default', async () => {
    const cache = new FacadeCache({
      asideCli: '/bin/false',
      runFn: async () => {
        throw new FacadeError('daemon down');
      },
    });
    await expect(fetchDefaultModel(cache)).rejects.toThrow('daemon down');
  });

  /** One spawn per 30s, not one per status poll. */
  it('caches, since /api/status is polled', async () => {
    let calls = 0;
    const cache = new FacadeCache({
      asideCli: '/bin/false',
      runFn: async () => {
        calls += 1;
        return LIVE_SHAPE;
      },
    });
    await fetchDefaultModel(cache);
    await fetchDefaultModel(cache);
    expect(calls).toBe(1);
  });
});
