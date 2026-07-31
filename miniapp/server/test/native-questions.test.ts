/**
 * The four ways a mobile session used to end up bricked on a native
 * question tool, and the fix for each.
 *
 * The failure this pins is real and was reported from production: a session
 * started from a phone called `ask_user_question`, the daemon suspended it
 * waiting for an answer only the desktop sidepanel can give, and the thread
 * was permanently unusable. Nothing here talks to Telegram or to a real
 * CLI: `aside_cli` is `/bin/echo` or a shell recorder.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { mintToken } from '../src/auth.js';
import {
  MOBILE_FOLLOWUP_REMINDER,
  MOBILE_SESSION_PREAMBLE,
  STRICT_CONFIRM_LINE,
  STRICT_FOLLOWUP_REMINDER,
  buildPreamble,
  isMobileSeededText,
  stripAgentDirectives,
  stripPreamble,
  stripReminder,
  withPreamble,
  withReminder,
} from '../src/preamble.js';
import {
  answerMessage,
  pendingNativeQuestion,
  recoveryPrompt,
  type QuestionItem,
} from '../src/questions.js';
import {
  MAX_SOFT_CONFIRM_ENTRIES,
  SoftConfirmStore,
} from '../src/softconfirm.js';
import { promptWithAttachments, splitAttachmentHeader } from '../src/uploads.js';
import { firstUserText, isMobileSession, scanTranscript } from '../src/sessions.js';
import {
  OWNER_ID,
  defaultFixtureRows,
  makeTestEnv,
  type TestEnv,
} from './helpers.js';

// --- gap 2 + gap 3, as pure functions ------------------------------------

describe('the preamble in both of its forms', () => {
  it('names both native tools and carries a parsable example', () => {
    expect(MOBILE_SESSION_PREAMBLE).toContain('ask_user_question');
    expect(MOBILE_SESSION_PREAMBLE).toContain('request_action_confirmation');
    const json = MOBILE_SESSION_PREAMBLE.split('[[QUESTION]]')[1]
      .split('[[/QUESTION]]')[0]
      .trim();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('adds the confirm-before-acting line only when asked', () => {
    expect(buildPreamble()).not.toContain(STRICT_CONFIRM_LINE);
    expect(buildPreamble({ strictConfirm: true })).toContain(
      STRICT_CONFIRM_LINE,
    );
    // The strict form must never mention the native tool as an option.
    expect(STRICT_CONFIRM_LINE).toContain('cannot be');
  });

  it('strips back off for display in either form', () => {
    expect(stripPreamble(withPreamble('summarise my inbox'))).toBe(
      'summarise my inbox',
    );
    expect(
      stripPreamble(withPreamble('summarise my inbox', { strictConfirm: true })),
    ).toBe('summarise my inbox');
  });
});

describe('the follow-up reminder', () => {
  it('rides at the END of the prompt, so nothing leads with a dash', () => {
    const prompt = withReminder('- actually, do X instead');
    expect(prompt.startsWith('- actually')).toBe(true);
    expect(prompt.endsWith(MOBILE_FOLLOWUP_REMINDER)).toBe(true);
  });

  it('names both tools, in both forms', () => {
    for (const line of [MOBILE_FOLLOWUP_REMINDER, STRICT_FOLLOWUP_REMINDER]) {
      expect(line).toContain('ask_user_question');
      expect(line).toContain('request_action_confirmation');
      expect(line).toContain('[[QUESTION]]');
    }
    expect(STRICT_FOLLOWUP_REMINDER).toContain('irreversible');
  });

  it('is one line of prompt, not a second preamble', () => {
    // The whole reason it is a line and not the block: it is paid for on
    // every single message.
    expect(MOBILE_FOLLOWUP_REMINDER.length).toBeLessThan(200);
    expect(STRICT_FOLLOWUP_REMINDER.length).toBeLessThan(260);
  });

  it('round-trips out of the user bubble', () => {
    expect(stripReminder(withReminder('what is on my calendar'))).toBe(
      'what is on my calendar',
    );
    expect(
      stripReminder(withReminder('what is on my calendar', { strictConfirm: true })),
    ).toBe('what is on my calendar');
  });

  it('composes with the attachment header in both directions', () => {
    const sent = withReminder(
      promptWithAttachments('what do you make of these', [
        '/tmp/a1b2c3d4e5f6-shot.png',
      ]),
    );
    // The agent sees the paths first and the reminder last.
    expect(sent.indexOf('[user sent')).toBe(0);
    expect(sent.endsWith(MOBILE_FOLLOWUP_REMINDER)).toBe(true);
    // The reader sees neither.
    const split = splitAttachmentHeader(stripAgentDirectives(sent));
    expect(split.text).toBe('what do you make of these');
    expect(split.files).toEqual([{ name: 'shot.png' }]);
  });

  it('composes with a question answer without reintroducing the dash bug', () => {
    const sent = withReminder(answerMessage('Colour test', 'Red'));
    expect(sent.startsWith('Colour test: Red')).toBe(true);
    expect(stripAgentDirectives(sent)).toBe('Colour test: Red');
  });

  it('strips a preamble and a reminder from the same message', () => {
    const both = withReminder(withPreamble('kick things off'));
    expect(stripAgentDirectives(both)).toBe('kick things off');
  });
});

describe('recognising a session driven from a phone', () => {
  it('sees this app’s preamble and bridge.py’s persona seed', () => {
    expect(isMobileSeededText(withPreamble('hi'))).toBe(true);
    expect(
      isMobileSeededText(
        "hey it's sam. i'm setting up this session as my permanent " +
          'telegram thread -- my main aside agent built a bridge',
      ),
    ).toBe(true);
  });

  it('does not claim a session someone started at their desk', () => {
    expect(isMobileSeededText('refactor the parser')).toBe(false);
    expect(isMobileSeededText('')).toBe(false);
  });
});

// --- gap 4, as a pure function -------------------------------------------

const stuckQuestion: QuestionItem = {
  kind: 'question',
  id: 'q-1',
  variant: 'ask',
  source: 'tool',
  questions: [
    {
      header: 'Send test email?',
      question: 'Approve sending it?',
      options: [
        { label: 'Approve', description: 'Send it now' },
        { label: 'Deny', description: 'Just confirm the draft' },
      ],
    },
  ],
  status: 'pending',
  answerable: false,
};

describe('picking the question a stuck session is parked on', () => {
  it('finds the newest pending native one', () => {
    const older = { ...stuckQuestion, id: 'q-0' };
    const found = pendingNativeQuestion([
      { kind: 'user' } as any,
      older,
      stuckQuestion,
    ]);
    expect(found?.id).toBe('q-1');
  });

  it('ignores a soft-marker question, which can just be answered', () => {
    expect(
      pendingNativeQuestion([
        { ...stuckQuestion, source: 'marker', answerable: true },
      ]),
    ).toBeNull();
  });

  it('ignores one that has already been answered', () => {
    expect(
      pendingNativeQuestion([{ ...stuckQuestion, status: 'answered' }]),
    ).toBeNull();
  });
});

describe('the recovery seed', () => {
  it('carries the question, the options and the answer', () => {
    const seed = recoveryPrompt({
      question: stuckQuestion,
      answer: 'Approve',
      firstMessage: 'draft a test email to sam and send it',
    });
    expect(seed).toContain('Send test email?');
    expect(seed).toContain('Approve sending it?');
    expect(seed).toContain('Approve / Deny');
    expect(seed).toContain('My answer: Approve');
    expect(seed).toContain('draft a test email to sam and send it');
  });

  it('is a preface, not a replay -- long context is clipped', () => {
    const seed = recoveryPrompt({
      question: stuckQuestion,
      answer: 'Approve',
      firstMessage: 'x'.repeat(5000),
    });
    expect(seed.length).toBeLessThan(2000);
    expect(seed).toContain('…');
  });

  it('still reads sensibly with nothing but the question', () => {
    const seed = recoveryPrompt({ question: stuckQuestion });
    expect(seed).toContain('Send test email?');
    expect(seed).not.toContain('My answer:');
  });
});

// --- the soft-confirm store ----------------------------------------------

describe('SoftConfirmStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'softconf-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('remembers across instances', () => {
    const file = path.join(dir, 'soft.json');
    new SoftConfirmStore(file).set('sessA', true);
    expect(new SoftConfirmStore(file).has('sessA')).toBe(true);
    new SoftConfirmStore(file).set('sessA', false);
    expect(new SoftConfirmStore(file).has('sessA')).toBe(false);
  });

  it('is bounded, so it cannot grow with the sessions directory', () => {
    const file = path.join(dir, 'soft.json');
    const store = new SoftConfirmStore(file);
    for (let i = 0; i < MAX_SOFT_CONFIRM_ENTRIES + 25; i += 1) {
      store.set(`sess${i}`, true);
    }
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
    expect(kept).toHaveLength(MAX_SOFT_CONFIRM_ENTRIES);
    // Oldest go first; the most recent toggle is the one still open.
    expect(store.has(`sess${MAX_SOFT_CONFIRM_ENTRIES + 24}`)).toBe(true);
    expect(store.has('sess0')).toBe(false);
  });

  it('treats a missing or corrupt file as empty rather than throwing', () => {
    expect(new SoftConfirmStore(path.join(dir, 'nope.json')).has('x')).toBe(
      false,
    );
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not json at all');
    expect(new SoftConfirmStore(bad).has('x')).toBe(false);
  });
});

// --- display: the session list ------------------------------------------

describe('the session list title', () => {
  it('is the user’s message, not the preamble it rode in on', () => {
    const transcript = [
      JSON.stringify({
        role: 'user',
        content: withPreamble('plan the offsite agenda'),
      }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'on it' }],
      }),
    ].join('\n');
    const scan = scanTranscript(transcript);
    expect(scan.title).toBe('plan the offsite agenda');
    expect(scan.title).not.toContain('Aside Mini App session');
  });

  it('drops the follow-up reminder too', () => {
    const transcript = JSON.stringify({
      role: 'user',
      content: withReminder('check the deploy'),
    });
    expect(scanTranscript(transcript).title).toBe('check the deploy');
  });
});

// --- routes ---------------------------------------------------------------

let env: TestEnv;
let app: FastifyInstance;
let token: string;
let argvLog: string;

/** Separates recorded arguments; a prompt now contains newlines. */
const ARG_SEP = '@@ARG@@';

/**
 * A rig whose CLI is a shell recorder.
 *
 * It does three things a real `aside` binary does and the `/bin/echo`
 * stand-in the other API tests use does not:
 *  - records every argument verbatim, separator-delimited, so the exact
 *    prompt can be asserted. Splitting on newlines would hide the
 *    reminder, which sits on its own line;
 *  - creates a session directory for an `exec` with no `--session`, which
 *    is what `createSession` discovers a new id from;
 *  - answers `repl` with the facade's own sentinel, so a permission write
 *    resolves instead of failing the request.
 */
async function bootRecorder(rows = defaultFixtureRows()) {
  env = makeTestEnv({ __stateRows: rows });
  argvLog = path.join(env.root, 'argv.log');
  const recorder = path.join(env.root, 'recorder.sh');
  fs.writeFileSync(
    recorder,
    [
      '#!/bin/sh',
      `for a in "$@"; do printf '%s${ARG_SEP}' "$a"; done >> ${JSON.stringify(argvLog)}`,
      'case "$1" in',
      "  repl) echo '<<<ASIDE_JSONnullASIDE_JSON>>>' ;;",
      '  exec)',
      '    case "$*" in',
      '      *--session*) ;;',
      `      *) mkdir -p ${JSON.stringify(env.sessionsDir)}"/2026-09-09_made$$" ;;`,
      '    esac ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    env.configPath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(env.configPath, 'utf8')),
      aside_cli: recorder,
    }),
  );
  const config = loadConfig();
  const secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret }));
  await app.ready();
  token = mintToken(secret, { sub: String(OWNER_ID), uid: OWNER_ID });
}

const auth = () => ({ authorization: `Bearer ${token}` });

/** Every argv the recorder has seen so far, across all invocations. */
async function recordedArgs(match: string): Promise<string[]> {
  for (let i = 0; i < 100; i += 1) {
    if (fs.existsSync(argvLog)) {
      const args = fs.readFileSync(argvLog, 'utf8').split(ARG_SEP);
      if (args.some((a) => a.includes(match))) return args;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the CLI never saw an argument containing ${match}`);
}

/**
 * Guarded, because the unit describes above share this file and never
 * boot a server. Without the guard every one of them fails in teardown.
 */
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined as unknown as FastifyInstance;
  }
  if (env) {
    env.cleanup();
    env = undefined as unknown as TestEnv;
  }
});

describe('gap 3: follow-ups carry the reminder', () => {
  beforeEach(() => bootRecorder());

  it('appends it to an ordinary send', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth(),
      payload: { text: 'how did the deploy go' },
    });
    const args = await recordedArgs('how did the deploy go');
    const prompt = args.find((a) => a.includes('how did the deploy go'))!;
    expect(prompt).toBe(`how did the deploy go\n\n${MOBILE_FOLLOWUP_REMINDER}`);
    // The `--` terminator is still immediately before the prompt.
    expect(args[args.indexOf(prompt) - 1]).toBe('--');
  });

  it('appends it to a question answer without leading with a dash', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/answer',
      headers: auth(),
      payload: { header: 'Colour test', label: 'Red' },
    });
    const args = await recordedArgs('Colour test: Red');
    const prompt = args.find((a) => a.includes('Colour test: Red'))!;
    expect(prompt.startsWith('Colour test: Red')).toBe(true);
    expect(prompt.endsWith(MOBILE_FOLLOWUP_REMINDER)).toBe(true);
    expect(args[args.indexOf(prompt) - 1]).toBe('--');
  });

  it('is removed again by the display path, so bubbles stay clean', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth(),
      payload: { text: 'look at this' },
    });
    const args = await recordedArgs('look at this');
    const prompt = args.find((a) => a.includes('look at this'))!;
    expect(stripAgentDirectives(prompt)).toBe('look at this');
  });
});

describe('gap 2: the confirm toggle never arms the native tool', () => {
  beforeEach(() => bootRecorder());

  it('turns the daemon flag OFF on a session this app creates', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sessions/new',
      headers: auth(),
      // The switch is ON, which is exactly the case that used to brick.
      payload: { text: 'book me a table', finalConfirm: true },
    });
    const args = await recordedArgs('aside.sessions.update');
    const update = args.find((a) => a.includes('aside.sessions.update'))!;
    expect(update).toContain('"finalConfirm":false');
    expect(update).not.toContain('"finalConfirm":true');
  });

  it('puts the strict line in the preamble instead', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sessions/new',
      headers: auth(),
      payload: { text: 'book me a table', finalConfirm: true },
    });
    const args = await recordedArgs('book me a table');
    const prompt = args.find((a) => a.includes('book me a table'))!;
    expect(prompt).toContain(STRICT_CONFIRM_LINE);
  });

  it('leaves the default preamble alone when the switch is off', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sessions/new',
      headers: auth(),
      payload: { text: 'book me a table' },
    });
    const args = await recordedArgs('book me a table');
    const prompt = args.find((a) => a.includes('book me a table'))!;
    expect(prompt).not.toContain(STRICT_CONFIRM_LINE);
    expect(prompt).toContain('never call ask_user_question');
  });

  it('never writes the native flag true on a mobile session', async () => {
    // fixtureAAAA's transcript is seeded with the mobile preamble below.
    const dir = path.join(env.sessionsDir, '2026-01-02_fixtureAAAA');
    fs.writeFileSync(
      path.join(dir, 'messages.jsonl'),
      `${JSON.stringify({ role: 'user', content: withPreamble('hi') })}\n`,
    );
    expect(isMobileSession(env.sessionsDir, 'fixtureAAAA')).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/permission',
      headers: auth(),
      payload: { finalConfirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ softConfirm: true, finalConfirm: true });

    const args = await recordedArgs('aside.sessions.update');
    const update = args.find((a) => a.includes('aside.sessions.update'))!;
    expect(update).toContain('"finalConfirm":false');
  });

  it('keeps the daemon flag on a session started at the desk', async () => {
    // fixtureBBBB's transcript carries no mobile seed, so the sidepanel is
    // there to answer and the switch means what it always did.
    expect(isMobileSession(env.sessionsDir, 'fixtureBBBB')).toBe(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureBBBB/permission',
      headers: auth(),
      payload: { finalConfirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().softConfirm).toBe(false);
    const args = await recordedArgs('aside.sessions.update');
    const update = args.find((a) => a.includes('aside.sessions.update'))!;
    expect(update).toContain('"finalConfirm":true');
  });
});

describe('gap 4: continuing from a stuck session', () => {
  const suspendedRows = () =>
    defaultFixtureRows().map((row) =>
      row.id === 'fixtureAAAA' ? { ...row, status: 'suspended' } : row,
    );

  /** Park fixtureAAAA on a native question nobody here can answer. */
  const parkOnNativeQuestion = () => {
    const dir = path.join(env.sessionsDir, '2026-01-02_fixtureAAAA');
    fs.writeFileSync(
      path.join(dir, 'messages.jsonl'),
      [
        JSON.stringify({
          role: 'user',
          content: withPreamble('draft a test email to sam and send it'),
          timestamp: 1,
        }),
        JSON.stringify({
          role: 'assistant',
          timestamp: 2,
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'ask_user_question',
              arguments: {
                questions: [
                  {
                    header: 'Send test email?',
                    question: 'Approve sending it?',
                    options: [
                      { label: 'Approve', description: 'Send it now' },
                      { label: 'Deny', description: 'Hold off' },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      ].join('\n') + '\n',
    );
  };

  beforeEach(() => bootRecorder(suspendedRows()));

  it('refuses when there is nothing stuck to continue from', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/recover',
      headers: auth(),
      payload: { answer: 'Approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_pending_question');
  });

  it('seeds a NEW session with the question and the tapped answer', async () => {
    parkOnNativeQuestion();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/recover',
      headers: auth(),
      payload: { answer: 'Approve' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toBe('fixtureAAAA');
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).not.toBe('fixtureAAAA');

    const args = await recordedArgs('Send test email?');
    const prompt = args.find((a) => a.includes('Send test email?'))!;
    // It is a new session, so it carries the whole preamble...
    expect(prompt).toContain('never call ask_user_question');
    // ...and the context that makes it useful.
    expect(prompt).toContain('My answer: Approve');
    expect(prompt).toContain('draft a test email to sam and send it');
    // The stuck session's own preamble is not carried over on top.
    expect(prompt.indexOf('[Aside Mini App session.')).toBe(
      prompt.lastIndexOf('[Aside Mini App session.'),
    );
    // Started as a new session, not a continuation of the dead one.
    expect(args).not.toContain('fixtureAAAA');
  });

  it('leaves the stuck session exactly as it was', async () => {
    parkOnNativeQuestion();
    const file = path.join(
      env.sessionsDir,
      '2026-01-02_fixtureAAAA',
      'messages.jsonl',
    );
    const before = fs.readFileSync(file, 'utf8');
    await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/recover',
      headers: auth(),
      payload: { answer: 'Approve' },
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('rejects an id that is not a session id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/..%2Fetc/recover',
      headers: auth(),
      payload: { answer: 'Approve' },
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});

describe('reading a transcript’s first message', () => {
  beforeEach(() => bootRecorder());

  it('finds it and survives a file that is not there', () => {
    const dir = path.join(env.sessionsDir, '2026-01-02_fixtureAAAA');
    fs.writeFileSync(
      path.join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'assistant', content: [] }),
        JSON.stringify({ role: 'user', content: 'the real opening line' }),
        JSON.stringify({ role: 'user', content: 'a later one' }),
      ].join('\n') + '\n',
    );
    expect(firstUserText(path.join(dir, 'messages.jsonl'))).toBe(
      'the real opening line',
    );
    expect(firstUserText(path.join(dir, 'nope.jsonl'))).toBe('');
  });
});
