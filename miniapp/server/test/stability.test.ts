/**
 * Regression tests for the stability batch.
 *
 * Each block pins one of the bugs this round fixed, at the level the bug
 * actually lived: the todo replay and the error classifier are pure
 * functions, the question rendering and the fold ids are properties of
 * `buildThread`, and stop / suspend are properties of the runner.
 *
 * The transcript shapes here are copied from real sessions on disk, not
 * invented -- notably the `stopReason: "error"` record with an EMPTY
 * content array, which is the exact shape that used to render as a blank
 * response.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyError,
  errorText,
  execFailureAlert,
  isAuthFailure,
  isProviderDown,
  isRateLimited,
  parseErrorEnvelope,
} from '../src/errors.js';
import {
  answerMessage,
  parseQuestionMarker,
  questionsFromToolCall,
  summariseArtifact,
} from '../src/questions.js';
import {
  applyTodoCall,
  readTodos,
  replayTodos,
  todoSummary,
} from '../src/todos.js';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normaliseSettings,
  resolveNewSessionModel,
} from '../src/settings.js';
import {
  MOBILE_SESSION_PREAMBLE,
  stripPreamble,
  withPreamble,
} from '../src/preamble.js';
import { buildThread, currentTodos, threadStats } from '../src/thread.js';
import { TurnRunner } from '../src/exec.js';
import { isSuspended } from '../src/statedb.js';
import type { HistoryMessage } from '../src/jsonl.js';

// --- deliverable 3: errors are classified, not swallowed ------------------

describe('provider error classification', () => {
  it('reads a rate limit out of a bare status line', () => {
    // Verbatim from a real transcript (2026-07-09, cerebras).
    expect(isRateLimited('429 status code (no body)')).toBe(true);
    const alert = classifyError('429 status code (no body)');
    expect(alert.title).toBe('Request rate limited');
    expect(alert.description).toBe(
      'The model provider temporarily rate-limited this request. Try again later.',
    );
    expect(alert.detail).toBe('429 status code (no body)');
  });

  it('reads a rate limit out of an appended JSON envelope', () => {
    const raw =
      'Error: {"error":{"type":"rate_limit_error","message":"The usage limit has been reached","status":429}}';
    expect(parseErrorEnvelope(raw)?.type).toBe('rate_limit_error');
    // The envelope's own message reads better than the JSON around it, so
    // that is what goes behind Details.
    expect(errorText(raw)).toBe('The usage limit has been reached');
    expect(classifyError(raw).title).toBe('Request rate limited');
  });

  it('separates a provider outage from a rate limit', () => {
    expect(isProviderDown('502 Bad Gateway')).toBe(true);
    expect(isRateLimited('502 Bad Gateway')).toBe(false);
    expect(classifyError('overloaded_error').title).toBe(
      'The AI provider is temporarily unavailable.',
    );
  });

  it('names the right reconnect for an expired OAuth provider', () => {
    expect(isAuthFailure('401 Unauthorized')).toBe(true);
    expect(
      classifyError('401 Unauthorized', { provider: 'openai-codex' }),
    ).toMatchObject({
      title: 'Provider sign-in expired',
      description:
        'Reconnect ChatGPT in Aside on your computer, then try the task again.',
    });
    expect(
      classifyError('invalid api key', { provider: 'cerebras' }).title,
    ).toBe('Provider authentication failed');
  });

  it('falls back to a generic destructive card', () => {
    const alert = classifyError('Request timed out.');
    expect(alert.title).toBe('There was an error while running the task');
    expect(alert.tone).toBe('destructive');
    expect(alert.detail).toBe('Request timed out.');
  });

  it('reports a non-zero CLI exit with its stderr tail behind Details', () => {
    const alert = execFailureAlert(1, 'aside: could not open session\n');
    expect(alert.title).toBe('The task could not be run');
    expect(alert.description).toBe('The Aside CLI exited with code 1.');
    expect(alert.detail).toBe('aside: could not open session');
  });

  it('still classifies a provider failure that arrived through stderr', () => {
    expect(execFailureAlert(1, 'API error: 429 too many requests').title).toBe(
      'Request rate limited',
    );
  });

  it('never puts an injected system-message block on screen', () => {
    const alert = classifyError(
      'boom <system-message>secret context</system-message>',
    );
    expect(alert.detail).not.toContain('secret context');
  });
});

describe('an errored turn renders as a card rather than a blank response', () => {
  it('builds an error item from a stopReason record with empty content', () => {
    // The exact shape on disk: nothing in `content` says anything failed,
    // which is why a content-only builder showed nothing at all.
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      {
        role: 'assistant',
        content: [],
        provider: 'openai-codex',
        stopReason: 'error',
        errorMessage: '429 status code (no body)',
        timestamp: 2000,
      },
    ];
    const items = buildThread(messages, false);
    const error = items.find((item) => item.kind === 'error');
    expect(error).toBeDefined();
    expect(error).toMatchObject({
      kind: 'error',
      text: '429 status code (no body)',
      alert: { title: 'Request rate limited' },
    });
  });

  it('ignores a stopReason of error with no message', () => {
    const items = buildThread(
      [
        { role: 'user', content: 'hi', timestamp: 1 },
        { role: 'assistant', content: [], stopReason: 'error', timestamp: 2 },
      ] as HistoryMessage[],
      false,
    );
    expect(items.some((item) => item.kind === 'error')).toBe(false);
  });
});

// --- deliverable 2: questions, never stuck --------------------------------

describe('question tool calls become cards, not JSON steps', () => {
  const askArgs = {
    questions: [
      {
        question: 'Approve sending it?',
        header: 'Send test email?',
        options: [
          { label: 'Approve', description: 'Send the test email now' },
          { label: 'Deny', description: 'Just confirm the draft looked right' },
        ],
      },
    ],
  };

  it('parses ask_user_question arguments', () => {
    const parsed = questionsFromToolCall('ask_user_question', askArgs);
    expect(parsed?.variant).toBe('ask');
    expect(parsed?.questions[0].header).toBe('Send test email?');
    expect(parsed?.questions[0].options).toHaveLength(2);
  });

  it('parses request_action_confirmation into an approve/cancel card', () => {
    const parsed = questionsFromToolCall('request_action_confirmation', {
      title: 'Create test calendar event',
      message: 'I want to create a test event tonight. Confirm and I will add it.',
      artifact: {
        type: 'calendar-event-draft',
        data: { title: 'Test Event', attendees: [], location: '' },
      },
    });
    expect(parsed?.variant).toBe('confirm');
    expect(parsed?.questions[0].options.map((o) => o.label)).toEqual([
      'Approve',
      'Cancel',
    ]);
    // Empty values are dropped rather than shown as blank rows.
    expect(parsed?.artifact?.summary).toEqual([
      { label: 'title', value: 'Test Event' },
    ]);
  });

  it('drops an artifact with nothing worth showing', () => {
    expect(summariseArtifact({ type: 'x', data: {} })).toBeUndefined();
    expect(summariseArtifact(null)).toBeUndefined();
  });

  it('renders a pending native call as an unanswerable card, not a step', () => {
    const items = buildThread(
      [
        { role: 'user', content: 'send it', timestamp: 1 },
        {
          role: 'assistant',
          timestamp: 2,
          content: [
            { type: 'toolCall', id: 'call-1', name: 'ask_user_question', arguments: askArgs },
          ],
        },
      ] as HistoryMessage[],
      true,
    );

    const question = items.find((item) => item.kind === 'question');
    expect(question).toMatchObject({
      kind: 'question',
      source: 'tool',
      status: 'pending',
      // The whole point: the desktop sidepanel is the only thing that can
      // answer one of these.
      answerable: false,
    });
    // And it is NOT a work step, which is what produced the raw JSON and
    // the misleading "Success" badge.
    const work = items.find((item) => item.kind === 'work');
    expect(work).toBeUndefined();
  });

  it('does not leave the fold spinning on a suspended turn', () => {
    const items = buildThread(
      [
        { role: 'user', content: 'send it', timestamp: 1 },
        {
          role: 'assistant',
          timestamp: 2,
          content: [
            { type: 'toolCall', id: 'c0', name: 'bash', arguments: { title: 'Check' } },
            { type: 'toolCall', id: 'c1', name: 'ask_user_question', arguments: askArgs },
          ],
        },
      ] as HistoryMessage[],
      // `running` is true -- the session is busy -- and the fold must STILL
      // settle, because the turn is parked on a question, not working.
      true,
    );
    const work = items.find((item) => item.kind === 'work');
    expect(work).toMatchObject({ kind: 'work', running: false });
  });

  it('settles a question once its result lands', () => {
    const items = buildThread(
      [
        { role: 'user', content: 'go', timestamp: 1 },
        {
          role: 'assistant',
          timestamp: 2,
          content: [
            { type: 'toolCall', id: 'c1', name: 'ask_user_question', arguments: askArgs },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          timestamp: 3,
          content: [
            {
              type: 'text',
              text: 'Asked user 1 question(s). Received response.\n\nUser responses to asked questions:\n- Send test email?: Approve',
            },
          ],
        },
      ] as HistoryMessage[],
      false,
    );
    expect(items.find((item) => item.kind === 'question')).toMatchObject({
      status: 'answered',
      answer: 'Send test email?: Approve',
      answerable: false,
    });
  });
});

describe('the soft question protocol', () => {
  it('parses a [[QUESTION]] block and keeps the prose around it', () => {
    const parsed = parseQuestionMarker(
      'Here is what I found.\n\n[[QUESTION]]\n{"questions":[{"header":"Deploy?","question":"Ship it?","options":[{"label":"Yes","description":"Deploy now"}]}]}\n[[/QUESTION]]',
    );
    expect(parsed?.variant).toBe('ask');
    expect(parsed?.questions[0].header).toBe('Deploy?');
    expect(parsed?.rest).toBe('Here is what I found.');
  });

  it('accepts a single bare question object', () => {
    const parsed = parseQuestionMarker(
      '[[QUESTION]]{"question":"Which one?","options":[{"label":"A","description":""}]}[[/QUESTION]]',
    );
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0].header).toBe('Question');
  });

  it("still understands bridge.py's [[APPROVAL]] block", () => {
    const parsed = parseQuestionMarker(
      '[[APPROVAL]]\nAction: Send the email\nDetails: to sai, subject "hello"\n[[/APPROVAL]]',
    );
    expect(parsed?.variant).toBe('confirm');
    expect(parsed?.questions[0].header).toBe('Send the email');
    expect(parsed?.questions[0].options.map((o) => o.label)).toEqual([
      'Approve',
      'Deny',
    ]);
  });

  it('leaves malformed markers as ordinary text rather than empty cards', () => {
    expect(parseQuestionMarker('[[QUESTION]]not json[[/QUESTION]]')).toBeNull();
    expect(parseQuestionMarker('no marker here')).toBeNull();
  });

  it('renders a marker question as an ANSWERABLE card', () => {
    const items = buildThread(
      [
        { role: 'user', content: 'go', timestamp: 1 },
        {
          role: 'assistant',
          timestamp: 2,
          content: [
            {
              type: 'text',
              text: 'Ready when you are.\n[[QUESTION]]{"questions":[{"header":"Ship?","question":"Deploy now?","options":[{"label":"Yes","description":"go"}]}]}[[/QUESTION]]',
            },
          ],
        },
      ] as HistoryMessage[],
      false,
    );
    expect(items.find((item) => item.kind === 'question')).toMatchObject({
      source: 'marker',
      // The turn ended cleanly, so a reply is just a follow-up message.
      answerable: true,
    });
    // The marker itself never reaches the screen as text.
    const answer = items.find((item) => item.kind === 'answer');
    expect(answer).toMatchObject({ text: 'Ready when you are.' });
  });

  it('formats an answer so a multi-question card stays unambiguous', () => {
    expect(answerMessage('SAT date', 'Aug 22, 2026')).toBe(
      'SAT date: Aug 22, 2026',
    );
    expect(answerMessage('', 'Approve')).toBe('Approve');
  });

  it('never leads an answer with a dash', () => {
    // Live E2E: the old `- <header>: <label>` form was read by the CLI's
    // argument parser as a flag, and the follow-up turn died with
    // `unknown option '- Color test: Red'`. The `--` terminator in exec.ts
    // is the real fix; this keeps the wire format out of the blast radius
    // too, and it reads better in the transcript.
    expect(answerMessage('Color test', 'Red').startsWith('-')).toBe(false);
    expect(answerMessage('', '-- dashes --').startsWith('-')).toBe(true);
  });
});

describe('the mobile session preamble', () => {
  it('names both native tools it exists to prevent', () => {
    expect(MOBILE_SESSION_PREAMBLE).toContain('ask_user_question');
    expect(MOBILE_SESSION_PREAMBLE).toContain('request_action_confirmation');
  });

  it('teaches a marker the parser actually understands', () => {
    // The example in the instructions has to round-trip, or the agent is
    // being taught a format nothing reads.
    const parsed = parseQuestionMarker(MOBILE_SESSION_PREAMBLE);
    expect(parsed?.questions[0].header).toBe('Short heading');
    expect(parsed?.questions[0].options).toHaveLength(2);
  });

  it('round-trips: added to a prompt, stripped for display', () => {
    const wrapped = withPreamble('summarise my inbox');
    expect(wrapped.endsWith('summarise my inbox')).toBe(true);
    expect(stripPreamble(wrapped)).toBe('summarise my inbox');
  });

  it('never shows the preamble in the user bubble', () => {
    const items = buildThread(
      [{ role: 'user', content: withPreamble('hi there'), timestamp: 1 }],
      false,
    );
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hi there' });
  });
});

describe('suspended sessions', () => {
  it('recognises the daemon status that means "blocked on a question"', () => {
    expect(isSuspended('suspended')).toBe(true);
    expect(isSuspended('Suspended')).toBe(true);
    expect(isSuspended('running')).toBe(false);
    expect(isSuspended(null)).toBe(false);
  });
});

// --- deliverable 4: the fold's identity is stable -------------------------

describe('work fold identity across a turn', () => {
  /** A turn mid-flight: one step, then trailing commentary. */
  const midTurn: HistoryMessage[] = [
    { role: 'user', content: 'first', timestamp: 1 },
    {
      role: 'assistant',
      timestamp: 2,
      content: [{ type: 'text', text: 'done' }],
    },
    { role: 'user', content: 'second', timestamp: 3 },
    {
      role: 'assistant',
      timestamp: 4,
      content: [
        { type: 'toolCall', id: 'a', name: 'bash', arguments: { title: 'Look' } },
        { type: 'text', text: 'nearly there' },
      ],
    },
  ];

  it('keeps a fold id stable when its trailing text is promoted and demoted', () => {
    // Promoted: the trailing text is the answer, so the fold holds one step.
    const before = buildThread(midTurn, true);
    const foldBefore = before.find((item) => item.kind === 'work' && item.id !== 'work-0');

    // Demoted: another tool call arrives after the text, so the text falls
    // back into the fold and the answer item disappears. Under the old
    // positional ids this renumbered everything and remounted every fold,
    // discarding the reader's expand/collapse choice.
    const after = buildThread(
      [
        ...midTurn.slice(0, 3),
        {
          role: 'assistant',
          timestamp: 4,
          content: [
            { type: 'toolCall', id: 'a', name: 'bash', arguments: { title: 'Look' } },
            { type: 'text', text: 'nearly there' },
            { type: 'toolCall', id: 'b', name: 'bash', arguments: { title: 'More' } },
          ],
        },
      ] as HistoryMessage[],
      true,
    );
    const foldAfter = after.find(
      (item) => item.kind === 'work' && item.id === foldBefore?.id,
    );

    expect(foldBefore?.id).toBeDefined();
    expect(foldAfter).toBeDefined();
    expect(foldAfter?.id).toBe(foldBefore?.id);
  });

  it('gives every fold and answer a unique id', () => {
    const ids = buildThread(midTurn, false).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps ids unique when an error splits a turn', () => {
    const ids = buildThread(
      [
        { role: 'user', content: 'go', timestamp: 1 },
        {
          role: 'assistant',
          timestamp: 2,
          content: [{ type: 'toolCall', id: 'a', name: 'bash', arguments: {} }],
        },
        {
          role: 'assistant',
          timestamp: 3,
          content: [],
          stopReason: 'error',
          errorMessage: 'Request timed out.',
        },
        {
          role: 'assistant',
          timestamp: 4,
          content: [{ type: 'toolCall', id: 'b', name: 'bash', arguments: {} }],
        },
      ] as HistoryMessage[],
      false,
    ).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// --- deliverable 5: the footer starts when the turn does ------------------

describe('turn start time', () => {
  it('dates a turn from its user message, not its first assistant record', () => {
    const stats = threadStats([
      { role: 'user', content: 'go', timestamp: 1_000 },
      { role: 'assistant', content: [], timestamp: 90_000, usage: { output: 5 } },
    ] as HistoryMessage[]);
    // 89 seconds earlier -- which is exactly the window in which the footer
    // used to be missing.
    expect(stats.turnStartedAt).toBe(1_000);
  });

  it('clears the start time at each new user message', () => {
    const stats = threadStats([
      { role: 'user', content: 'one', timestamp: 1_000 },
      { role: 'assistant', content: [], timestamp: 2_000 },
      { role: 'user', content: 'two', timestamp: 5_000 },
    ] as HistoryMessage[]);
    expect(stats.turnStartedAt).toBe(5_000);
  });

  it('falls back to the assistant record when the user message is undated', () => {
    const stats = threadStats([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [], timestamp: 7_000 },
    ] as HistoryMessage[]);
    expect(stats.turnStartedAt).toBe(7_000);
  });
});

// --- deliverable 6: stop --------------------------------------------------

describe('stopping a turn', () => {
  /** A child process stand-in that records the signals it was sent. */
  function fakeChild() {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [] as string[];
    child.kill = (signal: string) => {
      child.signals.push(signal);
      return true;
    };
    return child;
  }

  function runnerWith(child: any, extra: Record<string, unknown> = {}) {
    return new TurnRunner({
      asideCli: '/nonexistent/aside',
      sessionsDir: '/nonexistent',
      execTimeoutMs: 60_000,
      defaultModel: 'claude-sonnet-5',
      defaultEffort: 'high',
      modelAliases: {},
      spawnFn: (() => child) as any,
      ...extra,
    });
  }

  it('SIGTERMs the driver it owns and reports the turn as stopped', async () => {
    const child = fakeChild();
    const runner = runnerWith(child);
    const finished: any[] = [];
    runner.on('turn_finished', (payload) => finished.push(payload));

    runner.send('s1', { text: 'hi', model: 'm', effort: 'high' });
    expect(runner.isBusy('s1')).toBe(true);

    expect(runner.stop('s1')).toBe(true);
    expect(child.signals).toEqual(['SIGTERM']);

    child.emit('close', null);
    expect(finished[0]).toMatchObject({ sessionId: 's1', stopped: true });
    // A deliberate stop is not a failure, so no card is raised.
    expect(finished[0].alert).toBeUndefined();
    expect(runner.isBusy('s1')).toBe(false);
  });

  it('drops anything queued behind the stopped turn', () => {
    const child = fakeChild();
    const runner = runnerWith(child);
    runner.send('s1', { text: 'one', model: 'm', effort: 'high' });
    runner.send('s1', { text: 'two', model: 'other', effort: 'high' });
    expect(runner.queuedCount('s1')).toBe(1);

    runner.stop('s1');
    expect(runner.queuedCount('s1')).toBe(0);
  });

  it('answers honestly when there is nothing to stop', () => {
    const runner = runnerWith(fakeChild());
    expect(runner.stop('never-ran')).toBe(false);
  });
});

describe('a dash-leading prompt still reaches the agent', () => {
  /**
   * The prompt is a positional argument, so anything starting with `-`
   * looks like a flag to the CLI's parser. Live E2E: tapping a question
   * option sent `- Color test: Red` and the turn died with exit code 1 and
   * `error: unknown option '- Color test: Red'`. Both spawn sites now send
   * `--` first, which the real binary honours.
   */
  function capturingRunner(captured: string[][], sessionsDir: string) {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    const runner = new TurnRunner({
      asideCli: '/nonexistent/aside',
      sessionsDir,
      execTimeoutMs: 60_000,
      defaultModel: 'claude-sonnet-5',
      defaultEffort: 'high',
      modelAliases: {},
      spawnFn: ((_cli: string, args: string[]) => {
        captured.push(args);
        return child;
      }) as any,
    });
    return { runner, child };
  }

  /** The prompt is the last argument; `--` must be the one before it. */
  function assertTerminated(args: string[], text: string) {
    expect(args[args.length - 1]).toBe(text);
    expect(args[args.length - 2]).toBe('--');
    // And nothing before the terminator may be mistaken for the prompt.
    expect(args.slice(0, -2)).not.toContain(text);
  }

  it('terminates options before a continuation turn’s prompt', () => {
    const captured: string[][] = [];
    const { runner } = capturingRunner(captured, '/nonexistent');
    const text = '- Color test: Red';
    runner.send('s1', { text, model: 'claude-code/x', effort: 'high' });

    expect(captured).toHaveLength(1);
    assertTerminated(captured[0], text);
    expect(captured[0].slice(4, 7)).toEqual(['session', 'resume', 's1']);
  });

  it('terminates options before a new session’s prompt', async () => {
    const captured: string[][] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-dash-'));
    try {
      const { runner } = capturingRunner(captured, dir);
      const text = '--help me instead';
      // No directory ever appears, so discovery gives up; the args were
      // captured at spawn time, which is all this asserts.
      await runner
        .createSession(
          { text, model: 'claude-code/x', effort: 'high' },
          { timeoutMs: 30, pollMs: 10 },
        )
        .catch(() => undefined);

      expect(captured).toHaveLength(1);
      assertTerminated(captured[0], text);
      expect(captured[0][0]).toBe('exec');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps batched messages together after the terminator', () => {
    const captured: string[][] = [];
    const { runner, child } = capturingRunner(captured, '/nonexistent');
    // The first send pumps straight away; the next two queue behind it and
    // batch into one turn when it settles, since they share model+effort.
    runner.send('s1', { text: '-one', model: 'm', effort: 'high' });
    runner.send('s1', { text: '-two', model: 'm', effort: 'high' });
    runner.send('s1', { text: '-three', model: 'm', effort: 'high' });
    expect(captured).toHaveLength(1);
    assertTerminated(captured[0], '-one');

    child.emit('close', 0);

    // The joined text is still ONE positional argument behind ONE `--`.
    expect(captured).toHaveLength(2);
    assertTerminated(captured[1], '-two\n\n-three');
    expect(captured[1].filter((arg) => arg === '--')).toHaveLength(1);
  });

  it('passes an ordinary prompt through unchanged apart from the marker', () => {
    const captured: string[][] = [];
    const { runner } = capturingRunner(captured, '/nonexistent');
    runner.send('s1', { text: 'hello there', model: 'm', effort: 'low' });
    expect(captured[0]).toEqual([
      '-m',
      'm',
      '--effort',
      'low',
      'session',
      'resume',
      's1',
      '--',
      'hello there',
    ]);
  });
});

describe('the suspend watchdog', () => {
  it('reaps the driver when the session suspends, and says so', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.signals = [] as string[];
      child.kill = (signal: string) => {
        child.signals.push(signal);
        return true;
      };

      let status = 'running';
      const runner = new TurnRunner({
        asideCli: '/nonexistent/aside',
        sessionsDir: '/nonexistent',
        execTimeoutMs: 60_000,
        defaultModel: 'claude-sonnet-5',
        defaultEffort: 'high',
        modelAliases: {},
        spawnFn: (() => child) as any,
        readStatus: async () => status,
        watchdogMs: 10,
      });

      const finished: any[] = [];
      runner.on('turn_finished', (payload) => finished.push(payload));
      runner.send('s1', { text: 'ask me something', model: 'm', effort: 'high' });

      // Still running: nothing is killed.
      await vi.advanceTimersByTimeAsync(30);
      expect(child.signals).toEqual([]);

      // The agent calls ask_user_question and the daemon parks the session.
      status = 'suspended';
      await vi.advanceTimersByTimeAsync(30);
      expect(child.signals).toContain('SIGTERM');

      child.emit('close', null);
      expect(finished[0]).toMatchObject({ sessionId: 's1', suspended: true });
      // Parked, not failed: no error card.
      expect(finished[0].alert).toBeUndefined();
      expect(runner.isBusy('s1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- deliverable 7: the todo list ----------------------------------------

describe('write_todos replay', () => {
  const first = {
    merge: false,
    todos: [
      { id: '1', content: 'Write the profile page', status: 'in_progress' },
      { id: '2', content: 'Create people pages', status: 'pending' },
      { id: '3', content: 'Create company pages', status: 'pending' },
    ],
  };

  it('reads one call', () => {
    expect(readTodos(first.todos)).toHaveLength(3);
    expect(readTodos(first.todos)[0].status).toBe('in_progress');
  });

  it('replaces the whole list when merge is false', () => {
    const state = replayTodos([
      first,
      { merge: false, todos: [{ id: '9', content: 'Something else', status: 'pending' }] },
    ]);
    expect(state.map((todo) => todo.id)).toEqual(['9']);
  });

  it('merges by id, keeping position and untouched items', () => {
    const state = replayTodos([
      first,
      // A real merge call names only what changed -- which is precisely
      // what a "last call wins" read gets wrong.
      { merge: true, todos: [{ id: '1', content: 'Write the profile page', status: 'completed' }] },
    ]);
    expect(state).toHaveLength(3);
    expect(state[0]).toMatchObject({ id: '1', status: 'completed' });
    expect(state[1]).toMatchObject({ id: '2', status: 'pending' });
  });

  it('appends ids a merge introduces, at the end', () => {
    const state = applyTodoCall(
      readTodos(first.todos),
      readTodos([{ id: '4', content: 'A new one', status: 'pending' }]),
      true,
    );
    expect(state.map((todo) => todo.id)).toEqual(['1', '2', '3', '4']);
  });

  it('carries a cancellation through', () => {
    const state = replayTodos([
      first,
      { merge: true, todos: [{ id: '2', content: 'Create people pages', status: 'cancelled' }] },
    ]);
    expect(state[1].status).toBe('cancelled');
    // A cancelled item is not counted in the collapsed summary.
    expect(todoSummary(state)?.total).toBe(2);
  });

  it('defaults an absent merge flag to a full write', () => {
    const state = replayTodos([
      first,
      { todos: [{ id: '7', content: 'Only me', status: 'pending' }] },
    ]);
    expect(state.map((todo) => todo.id)).toEqual(['7']);
  });

  it('keys on content when a call omits ids', () => {
    const state = replayTodos([
      { merge: false, todos: [{ content: 'Do the thing', status: 'pending' }] },
      { merge: true, todos: [{ content: 'Do the thing', status: 'completed' }] },
    ]);
    expect(state).toHaveLength(1);
    expect(state[0].status).toBe('completed');
  });

  it('summarises the in-progress item, then the next pending one', () => {
    expect(todoSummary(replayTodos([first]))?.label).toBe(
      'Write the profile page',
    );
    const done = replayTodos([
      {
        merge: false,
        todos: [{ id: '1', content: 'Done', status: 'completed' }],
      },
    ]);
    expect(todoSummary(done)).toMatchObject({
      label: 'All tasks complete',
      done: 1,
      total: 1,
    });
    expect(todoSummary([])).toBeNull();
  });

  it('replays out of a transcript', () => {
    const todos = currentTodos([
      { role: 'user', content: 'go', timestamp: 1 },
      {
        role: 'assistant',
        timestamp: 2,
        content: [{ type: 'toolCall', id: 'a', name: 'write_todos', arguments: first }],
      },
      {
        role: 'assistant',
        timestamp: 3,
        content: [
          {
            type: 'toolCall',
            id: 'b',
            name: 'write_todos',
            arguments: {
              merge: true,
              todos: [{ id: '1', content: 'Write the profile page', status: 'completed' }],
            },
          },
        ],
      },
    ] as HistoryMessage[]);
    expect(todos[0].status).toBe('completed');
    expect(todos).toHaveLength(3);
  });

  it('ignores malformed entries rather than rendering blanks', () => {
    expect(readTodos([null, 5, { status: 'pending' }, { content: '  ' }])).toEqual(
      [],
    );
    expect(readTodos('nope')).toEqual([]);
  });

  it('falls back to pending for an unknown status', () => {
    expect(readTodos([{ id: '1', content: 'x', status: 'weird' }])[0].status).toBe(
      'pending',
    );
  });
});

// --- deliverable 1: settings ---------------------------------------------

describe('mini app settings', () => {
  it('normalises anything into a valid object', () => {
    expect(normaliseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normaliseSettings({ defaultEffort: 'max' }).defaultEffort).toBe('');
    expect(normaliseSettings({ defaultEffort: 'xhigh' }).defaultEffort).toBe(
      'xhigh',
    );
    expect(
      normaliseSettings({ defaultPermissionMode: 'root' }).defaultPermissionMode,
    ).toBeNull();
  });

  it('touches only the keys a patch actually carries', () => {
    const current = {
      ...DEFAULT_SETTINGS,
      defaultProvider: 'claude-code',
      defaultModelId: 'claude-sonnet-5',
    };
    const next = mergeSettings(current, { defaultEffort: 'low' });
    expect(next.defaultProvider).toBe('claude-code');
    expect(next.defaultModelId).toBe('claude-sonnet-5');
    expect(next.defaultEffort).toBe('low');
  });

  it('leaves the permission default null unless the owner sets one', () => {
    // The shipped posture: this app does not widen permissions on its own.
    expect(DEFAULT_SETTINGS.defaultPermissionMode).toBeNull();
    expect(
      mergeSettings(DEFAULT_SETTINGS, { defaultPermissionMode: 'full-access' })
        .defaultPermissionMode,
    ).toBe('full-access');
    expect(
      mergeSettings(DEFAULT_SETTINGS, { defaultPermissionMode: null })
        .defaultPermissionMode,
    ).toBeNull();
  });

  it('lets an explicit pick from the composer beat the stored default', () => {
    const stored = {
      ...DEFAULT_SETTINGS,
      defaultProvider: 'claude-code',
      defaultModelId: 'claude-sonnet-5',
    };
    expect(resolveNewSessionModel(stored, 'openai-codex/gpt-5.5')).toBe(
      'openai-codex/gpt-5.5',
    );
    expect(resolveNewSessionModel(stored, undefined)).toBe(
      'claude-code/claude-sonnet-5',
    );
    expect(resolveNewSessionModel(DEFAULT_SETTINGS, undefined)).toBeUndefined();
  });

  it('needs both halves of a model before it will send one', () => {
    expect(
      resolveNewSessionModel(
        { ...DEFAULT_SETTINGS, defaultProvider: 'claude-code' },
        undefined,
      ),
    ).toBeUndefined();
  });
});
