import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper shared with the dev harness
import { buildInitDataFields, signInitData } from '../../scripts/sign-initdata.mjs';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { mintToken } from '../src/auth.js';
import { defaultPairingPath, PairingStore } from '../src/pairing.js';
import { FAKE_BOT_TOKEN, OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let secret: string;

beforeEach(async () => {
  env = makeTestEnv();
  const config = loadConfig();
  secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  env.cleanup();
});

function validInitData(platform: 'ios' | 'desktop' = 'desktop'): string {
  return signInitData(
    buildInitDataFields({ userId: OWNER_ID, platform }),
    FAKE_BOT_TOKEN,
  );
}

async function authToken(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth',
    payload: { initDataRaw: validInitData() },
  });
  return res.json().token as string;
}

describe('POST /api/auth', () => {
  it('mints a token for a valid launch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: { initDataRaw: validInitData('ios') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.id).toBe(OWNER_ID);
    expect(typeof body.token).toBe('string');
  });

  it('401s a tampered payload and 403s a different user', async () => {
    const params = new URLSearchParams(validInitData());
    params.set('hash', 'deadbeef');
    const tampered = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: { initDataRaw: params.toString() },
    });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().reason).toBe('bad_signature');

    const stranger = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: {
        initDataRaw: signInitData(
          buildInitDataFields({ userId: OWNER_ID + 7 }),
          FAKE_BOT_TOKEN,
        ),
      },
    });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().reason).toBe('forbidden_user');
  });

  it('401s a stale launch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: {
        initDataRaw: signInitData(
          buildInitDataFields({
            userId: OWNER_ID,
            authDate: Math.floor(Date.now() / 1000) - 20 * 60,
          }),
          FAKE_BOT_TOKEN,
        ),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('expired');
  });

  it('rate limits brute force at 10/min', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth',
        payload: { initDataRaw: 'garbage' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('pairs a browser once and restores the session from its cookie', async () => {
    const config = loadConfig();
    const pairing = new PairingStore(defaultPairingPath(config.miniapp.stateDir), secret);
    const code = pairing.create();
    const paired = await app.inject({
      method: 'POST',
      url: '/api/auth/pair',
      payload: { code: ` ${code.toLowerCase()} ` },
    });
    expect(paired.statusCode).toBe(200);
    const cookie = paired.headers['set-cookie'];
    expect(cookie).toContain('aside_session=');

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: String(cookie).split(';')[0] },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.id).toBe(OWNER_ID);

    const reused = await app.inject({
      method: 'POST',
      url: '/api/auth/pair',
      payload: { code },
    });
    expect(reused.statusCode).toBe(401);
  });
});

describe('bearer token gate', () => {
  it('401s missing, garbage and expired tokens', async () => {
    const noHeader = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(noHeader.statusCode).toBe(401);
    expect(noHeader.json().reason).toBe('missing');

    const garbage = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(garbage.statusCode).toBe(401);
    expect(garbage.json().reason).toBe('invalid');

    const expired = mintToken(
      secret,
      { sub: String(OWNER_ID), uid: OWNER_ID },
      -10,
    );
    const stale = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().reason).toBe('expired');
  });

  it('401s a token signed with the wrong secret', async () => {
    const forged = mintToken('a'.repeat(64), {
      sub: String(OWNER_ID),
      uid: OWNER_ID,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s a validly signed token for a non-allowlisted user', async () => {
    const other = mintToken(secret, {
      sub: String(OWNER_ID + 1),
      uid: OWNER_ID + 1,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${other}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('forbidden');
  });
});

describe('standalone PWA push registration', () => {
  it('exposes a VAPID key and stores then removes a subscription', async () => {
    const token = await authToken();
    const config = await app.inject({
      method: 'GET',
      url: '/api/push/config',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(config.statusCode).toBe(200);
    expect(config.json().publicKey).toMatch(/^[A-Za-z0-9_-]+$/);

    const subscription = {
      endpoint: 'https://push.example.test/subscription/1',
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    };
    const saved = await app.inject({
      method: 'POST',
      url: '/api/push/subscription',
      headers: { authorization: `Bearer ${token}` },
      payload: { subscription },
    });
    expect(saved.statusCode).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/push/subscription',
      headers: { authorization: `Bearer ${token}` },
      payload: { endpoint: subscription.endpoint },
    });
    expect(removed.statusCode).toBe(200);
  });
});

describe('read API', () => {
  it('lists sessions and fetches a transcript', async () => {
    const token = await authToken();
    const auth = { authorization: `Bearer ${token}` };

    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions.map((s: any) => s.id).sort()).toEqual([
      'fixtureAAAA',
      'fixtureBBBB',
      'fixtureCCCC',
    ]);

    const messages = await app.inject({
      method: 'GET',
      url: '/api/sessions/fixtureAAAA/messages',
      headers: auth,
    });
    expect(messages.statusCode).toBe(200);
    const body = messages.json();
    expect(body.entries[0].kind).toBe('user');
    expect(body.busy).toBe(false);
    expect(body.lastLine).toBe(6);

    const tail = await app.inject({
      method: 'GET',
      url: '/api/sessions/fixtureAAAA/messages?afterLine=5',
      headers: auth,
    });
    expect(tail.json().entries.every((e: any) => e.line > 5)).toBe(true);
  });

  it('400s a bad session id and 404s an unknown one', async () => {
    const auth = { authorization: `Bearer ${await authToken()}` };
    const bad = await app.inject({
      method: 'GET',
      url: '/api/sessions/..%2F..%2Fetc/messages',
      headers: auth,
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/sessions/nosuchsession/messages',
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('write API', () => {
  it('accepts a send and reports it on /api/status', async () => {
    const auth = { authorization: `Bearer ${await authToken()}` };
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth,
      payload: { text: 'ping', model: 'sonnet', effort: 'low' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);

    const status = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: auth,
    });
    const body = status.json();
    expect(body.efforts).toContain('ultrabrowse');

    // The alias list gave way to the provider/model catalog.
    const providers = body.catalog.map((p: any) => p.id);
    expect(providers).toContain('claude-code');

    // "Max" is in Aside's own menu but the CLI rejects it, so it must not
    // be offered here.
    const effortIds = body.effortMenu.map((e: any) => e.id);
    expect(effortIds).toEqual(['low', 'medium', 'high', 'xhigh', 'ultrabrowse']);
    expect(effortIds).not.toContain('max');

    // With no reachable daemon the pills fall back to the config default.
    expect(body.defaults.modelId).toBe('claude-sonnet-5');
  });

  it('rejects empty text, oversized text and unknown sessions', async () => {
    const auth = { authorization: `Bearer ${await authToken()}` };
    const empty = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth,
      payload: { text: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const huge = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth,
      payload: { text: 'x'.repeat(40_000) },
    });
    expect(huge.statusCode).toBe(413);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/sessions/nosuchsession/send',
      headers: auth,
      payload: { text: 'hi' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
