/**
 * Route-level tests for the stability batch.
 *
 * These exercise the endpoints the new UI depends on, against the same
 * throwaway config + fixture-sessions rig the rest of the API tests use.
 * No real bridge config, no real state.db, no real CLI: `aside_cli` is
 * `/bin/echo`.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { mintToken } from '../src/auth.js';
import {
  OWNER_ID,
  defaultFixtureRows,
  makeTestEnv,
  type TestEnv,
} from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let token: string;

/**
 * A rig whose fixture table can be overridden -- used to mark a session
 * `suspended`, which is the state the composer and the send route both key
 * off.
 */
async function boot(rows = defaultFixtureRows()) {
  env = makeTestEnv({ __stateRows: rows });
  const config = loadConfig();
  const secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret, version: '9.9.9' }));
  await app.ready();
  token = mintToken(secret, { sub: String(OWNER_ID), uid: OWNER_ID });
}

const auth = () => ({ authorization: `Bearer ${token}` });

afterEach(async () => {
  await app.close();
  env.cleanup();
});

describe('GET/POST /api/settings', () => {
  beforeEach(() => boot());

  it('starts on the shipped defaults', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      defaultProvider: '',
      defaultModelId: '',
      defaultEffort: '',
      // Not full-access, and not guard either: "leave the daemon's own
      // default alone" is the only honest shipped value.
      defaultPermissionMode: null,
      defaultFinalConfirm: null,
    });
  });

  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/settings', payload: {} }))
        .statusCode,
    ).toBe(401);
  });

  it('persists a partial update and leaves the rest alone', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: auth(),
      payload: { defaultProvider: 'claude-code', defaultModelId: 'claude-fable-5' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: auth(),
      payload: { defaultEffort: 'xhigh' },
    });
    expect(res.json().settings).toMatchObject({
      defaultProvider: 'claude-code',
      defaultModelId: 'claude-fable-5',
      defaultEffort: 'xhigh',
    });

    // And it is on disk, 0600, outside the repo.
    const file = path.join(path.dirname(env.configPath), 'miniapp-settings.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rejects a body that is not an object', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: '["nope"]',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_body');
  });

  it('silently drops values the CLI would reject', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: auth(),
      // `max` is in Aside's own menu but `aside exec --effort` refuses it.
      payload: { defaultEffort: 'max', defaultPermissionMode: 'root' },
    });
    expect(res.json().settings.defaultEffort).toBe('');
    expect(res.json().settings.defaultPermissionMode).toBeNull();
  });
});

describe('POST /api/sessions/:id/stop', () => {
  beforeEach(() => boot());

  it('reports honestly when nothing is running', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/stop',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_running');
  });

  it('validates the session id before doing anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/..%2F..%2Fetc/stop',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/stop',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('a suspended session never jams the composer', () => {
  beforeEach(() =>
    boot(
      defaultFixtureRows().map((row) =>
        row.id === 'fixtureAAAA' ? { ...row, status: 'suspended' } : row,
      ),
    ),
  );

  it('reports the session as suspended on the thread read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/fixtureAAAA/thread',
      headers: auth(),
    });
    expect(res.json().suspended).toBe(true);
    expect(res.json().status).toBe('suspended');
  });

  it('refuses a send rather than queueing a turn that would hang', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth(),
      payload: { text: 'are you there?' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('session_suspended');
    // And it says where the question can actually be answered.
    expect(res.json().reason).toMatch(/Aside on your computer/);
  });

  it('refuses an answer for the same reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/answer',
      headers: auth(),
      payload: { header: 'Send email?', label: 'Approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('session_suspended');
  });

  it('still lets an idle session through', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureBBBB/send',
      headers: auth(),
      payload: { text: 'carry on' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
  });
});

describe('POST /api/sessions/:id/answer', () => {
  beforeEach(() => boot());

  it('accepts a choice and sends it as an ordinary message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/answer',
      headers: auth(),
      payload: { header: 'SAT date', label: 'Aug 22, 2026' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
  });

  it('rejects an empty choice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/answer',
      headers: auth(),
      payload: { header: 'x', label: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('empty_answer');
  });

  it('404s an unknown session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/2026-01-01_nosuchsession/answer',
      headers: auth(),
      payload: { label: 'Approve' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/status reports the service, without secrets', () => {
  beforeEach(() => boot());

  it('carries what the settings screen shows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: auth(),
    });
    const { service } = res.json();
    expect(service).toMatchObject({
      version: '9.9.9',
      tunnel: 'none',
      tunnelUrl: null,
    });
    expect(typeof service.port).toBe('number');
    // Nothing sensitive: no token, no user id, no absolute paths.
    const body = res.payload;
    expect(body).not.toContain('TEST-ONLY-FAKE-BOT-TOKEN');
    expect(body).not.toContain(String(OWNER_ID));
    expect(body).not.toContain(env.root);
  });
});

describe('a new session carries the mobile preamble', () => {
  beforeEach(() => boot());

  it('never shows it back in the thread', async () => {
    // The create path spawns the CLI, which is `/bin/echo` here, so this
    // asserts the display half: whatever a session's first message holds,
    // the preamble is not rendered. `stripPreamble` is unit-tested; this
    // pins that the thread route goes through it.
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/fixtureAAAA/thread',
      headers: auth(),
    });
    expect(res.payload).not.toContain('Aside Mini App session.');
  });
});
