/**
 * The round-3 endpoints, over the real app: uploads, the permission write,
 * the thread's new source, and the session list's new source.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper shared with the dev harness
import { buildInitDataFields, signInitData } from '../../scripts/sign-initdata.mjs';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { FAKE_BOT_TOKEN, OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  env = makeTestEnv();
  const config = loadConfig();
  const secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret }));
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

const auth = () => ({ authorization: `Bearer ${token}` });

/** A minimal multipart body; the browser builds these, tests do not. */
function multipart(
  files: Array<{ field?: string; name: string; type: string; body: Buffer | string }>,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----miniapptestboundary';
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.field || 'files'}"; ` +
          `filename="${file.name}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`,
      ),
      Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('POST /api/attachments', () => {
  it('requires a token', async () => {
    const { payload, headers } = multipart([
      { name: 'a.txt', type: 'text/plain', body: 'hello' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores a file and hands back its path', async () => {
    const { payload, headers } = multipart([
      { name: 'notes.txt', type: 'text/plain', body: 'hello from the phone' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...headers, ...auth() },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const [file] = res.json().files;
    expect(file.name).toBe('notes.txt');
    expect(file.size).toBe(20);
    expect(fs.readFileSync(file.path, 'utf8')).toBe('hello from the phone');
    // Inside the configured uploads root, in a dated directory.
    expect(file.path.startsWith(path.join(env.root, 'uploads'))).toBe(true);
  });

  it('sanitizes a traversal filename rather than honouring it', async () => {
    const { payload, headers } = multipart([
      { name: '../../../../tmp/escaped.sh', type: 'text/plain', body: 'x' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...headers, ...auth() },
      payload,
    });

    // Note both layers hold: @fastify/multipart already basenames the
    // Content-Disposition filename, and sanitizeFilename would reduce a
    // traversal to a leaf even if it did not.
    const [file] = res.json().files;
    expect(file.name).toBe('escaped.sh');
    expect(file.path.startsWith(path.join(env.root, 'uploads'))).toBe(true);
    expect(file.path).not.toContain('..');
    expect(fs.existsSync('/tmp/escaped.sh')).toBe(false);
  });

  it('rejects a file over the size cap', async () => {
    const { payload, headers } = multipart([
      { name: 'big.bin', type: 'application/octet-stream', body: Buffer.alloc(21 * 1024 * 1024) },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...headers, ...auth() },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('file_too_large');
  });

  it('rejects more than five files', async () => {
    const { payload, headers } = multipart(
      Array.from({ length: 6 }, (_, i) => ({
        name: `f${i}.txt`,
        type: 'text/plain',
        body: 'x',
      })),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...headers, ...auth() },
      payload,
    });
    expect(res.statusCode).toBe(413);
  });

  it('400s a request with no files at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: {
        ...auth(),
        'content-type': 'multipart/form-data; boundary=----x',
      },
      payload: Buffer.from('------x--\r\n'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a bad session id on the scoped route', async () => {
    const { payload, headers } = multipart([
      { name: 'a.txt', type: 'text/plain', body: 'x' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/..%2F..%2Fetc/attachments',
      headers: { ...headers, ...auth() },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Prompt construction, proved end to end.
 *
 * `aside_cli` is pointed at a recorder script, so what the child was
 * actually invoked with can be read back off disk -- which is the only way
 * to be sure the attachment header reached the agent rather than being
 * assembled and dropped.
 */
describe('sending with attachments', () => {
  let argvLog: string;

  beforeEach(async () => {
    await app.close();
    env.cleanup();

    env = makeTestEnv();
    argvLog = path.join(env.root, 'argv.log');
    const recorder = path.join(env.root, 'recorder.sh');
    fs.writeFileSync(
      recorder,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> ${JSON.stringify(argvLog)}\nprintf '\\n--\\n' >> ${JSON.stringify(argvLog)}\n`,
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

  const upload = async (name: string, body: string) => {
    const { payload, headers } = multipart([{ name, type: 'text/plain', body }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...headers, ...auth() },
      payload,
    });
    return res.json().files[0].path as string;
  };

  /** Wait for the recorder to have written the child's argv. */
  const recordedArgv = async (): Promise<string[]> => {
    for (let i = 0; i < 40; i += 1) {
      if (fs.existsSync(argvLog)) {
        const lines = fs.readFileSync(argvLog, 'utf8').split('\n');
        if (lines.includes('--')) return lines;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the CLI was never invoked');
  };

  it('prepends the saved paths to the prompt', async () => {
    const one = await upload('shot-one.txt', 'pixels');
    const two = await upload('shot-two.txt', 'more pixels');

    await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth(),
      payload: { text: 'what do you make of these', attachments: [one, two] },
    });

    const argv = await recordedArgv();
    const prompt = argv.find((a) => a.includes('[user sent'));
    expect(prompt).toBeDefined();
    expect(prompt).toBe(
      `[user sent 2 files from their phone, saved to: ${one}, ${two}] ` +
        'what do you make of these',
    );
    // The rest of the invocation is unchanged.
    expect(argv).toEqual(expect.arrayContaining(['session', 'resume', 'fixtureAAAA']));
  });

  /**
   * A client must not be able to name a file on the machine and have the
   * agent told to read it. Only paths this server issued are honoured.
   */
  it('drops a path the server never issued', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth(),
      payload: { text: 'read this', attachments: ['/etc/passwd'] },
    });

    const argv = await recordedArgv();
    expect(argv.join('\n')).not.toContain('/etc/passwd');
    expect(argv.join('\n')).not.toContain('[user sent');
    expect(argv).toContain('read this');
  });

  it('accepts a send that is attachments-only', async () => {
    const uploaded = await upload('shot.txt', 'pixels');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth(),
      payload: { text: '', attachments: [uploaded] },
    });
    expect(res.statusCode).toBe(200);

    const argv = await recordedArgv();
    expect(argv).toContain(
      `[user sent 1 file from their phone, saved to: ${uploaded}]`,
    );
  });

  it('still rejects a send with neither text nor attachments', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth(),
      payload: { text: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('empty_text');
  });
});

describe('POST /api/sessions/:id/permission', () => {
  it('requires a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/permission',
      payload: { mode: 'guard' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a mode the daemon would reject', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/permission',
      headers: auth(),
      payload: { mode: 'bogus-mode' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_mode');
  });

  it('rejects a non-boolean finalConfirm', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/permission',
      headers: auth(),
      payload: { finalConfirm: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_final_confirm');
  });

  it('rejects an empty change', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/permission',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('nothing_to_change');
  });

  it('404s an unknown session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nosuchsession/permission',
      headers: auth(),
      payload: { mode: 'guard' },
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * The response is read back OUT of the daemon's own state rather than
   * echoing the request, so the UI checkmarks reality. The stub CLI here
   * does not actually write, so the read still reports the fixture's
   * `full-access` -- which is exactly the property being pinned: a claimed
   * change that did not land is not reported as if it had.
   */
  it('reports the state it can read back, not the request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/permission',
      headers: auth(),
      payload: { mode: 'guard' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.permissionMode).toBe('full-access');
    expect(body.appliesFrom).toBe('next-message');
  });

  /** An unreachable daemon must 502 rather than claim success. */
  it('502s when the CLI cannot be run at all', async () => {
    await app.close();
    env.cleanup();

    env = makeTestEnv({ aside_cli: '/nonexistent/aside-binary' });
    const config = loadConfig();
    const secret = loadOrCreateJwtSecret(config.secretPath);
    ({ app } = await buildServer(config, { jwtSecret: secret }));
    await app.ready();
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: {
        initDataRaw: signInitData(
          buildInitDataFields({ userId: OWNER_ID, platform: 'ios' }),
          FAKE_BOT_TOKEN,
        ),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/permission',
      headers: { authorization: `Bearer ${fresh.json().token}` },
      payload: { mode: 'guard' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('permission_update_failed');
  });
});

describe('GET /api/status', () => {
  it('offers the permission menu and the upload limits', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: auth(),
    });
    const body = res.json();
    expect(body.permissionMenu.map((m: any) => m.id)).toEqual([
      'read-only',
      'guard',
      'full-access',
    ]);
    expect(body.uploads).toEqual({
      maxFiles: 5,
      maxBytes: 20 * 1024 * 1024,
    });
  });
});

describe('GET /api/sessions (state.db source)', () => {
  it('reads the daemon table and includes CLI sessions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: auth(),
    });
    const body = res.json();
    expect(body.source).toBe('statedb');
    expect(body.sessions.map((s: any) => s.id)).toEqual([
      'fixtureCCCC',
      'fixtureBBBB',
      'fixtureAAAA',
    ]);
  });

  /**
   * A CLI session's stored title is the placeholder "Aside CLI". Left as
   * is, the list would be a column of identical rows, so the title falls
   * back to the transcript's first user message -- with the bridge's
   * persona seed skipped, which is why fixtureCCCC does not title itself
   * "hey it's owner…".
   */
  it('derives a title for a placeholder-titled CLI session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: auth(),
    });
    const cli = res.json().sessions.find((s: any) => s.id === 'fixtureCCCC');
    expect(cli.title).not.toBe('Aside CLI');
    expect(cli.title.toLowerCase()).not.toContain('permanent telegram thread');
    expect(cli.title.length).toBeGreaterThan(0);
  });

  it('keeps a real title as the daemon has it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: auth(),
    });
    const row = res.json().sessions.find((s: any) => s.id === 'fixtureAAAA');
    expect(row.title).toBe('Fixture plan summary');
  });

  it('derives unread and running from the table', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: auth(),
    });
    const rows = res.json().sessions;
    const unread = rows.find((s: any) => s.id === 'fixtureBBBB');
    const read = rows.find((s: any) => s.id === 'fixtureAAAA');
    expect(unread.unread).toBe(true);
    expect(unread.status).toBe('running');
    expect(read.unread).toBe(false);
  });
});

describe('GET /api/sessions/:id/thread (jsonl source)', () => {
  it('reports the session’s permission mode and final-confirm flag', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/fixtureAAAA/thread',
      headers: auth(),
    });
    const body = res.json();
    expect(body.permission).toBe('Full access');
    expect(body.permissionMode).toBe('full-access');
    expect(body.finalConfirm).toBe(true);
  });

  /**
   * The whole point of the source change: a session whose transcript has
   * several turns renders all of them, not just the tail the agent's
   * current context happened to hold.
   */
  it('renders every turn on disk', async () => {
    const transcript = path.join(
      env.sessionsDir,
      '2026-01-02_fixtureAAAA',
      'messages.jsonl',
    );
    for (const [i, text] of ['turn two', 'turn three'].entries()) {
      fs.appendFileSync(
        transcript,
        `${JSON.stringify({ role: 'user', content: text, timestamp: 1767313000 + i * 10 })}\n` +
          `${JSON.stringify({
            role: 'assistant',
            content: [{ type: 'text', text: `answer ${i}` }],
            timestamp: 1767313001 + i * 10,
          })}\n`,
      );
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/fixtureAAAA/thread',
      headers: auth(),
    });
    const items = res.json().items;
    const users = items.filter((i: any) => i.kind === 'user');
    expect(users.map((u: any) => u.text)).toContain('turn two');
    expect(users.map((u: any) => u.text)).toContain('turn three');
    expect(items.filter((i: any) => i.kind === 'answer').length).toBeGreaterThanOrEqual(2);
  });

  it('404s a session with no transcript on disk', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nosuchsession/thread',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
