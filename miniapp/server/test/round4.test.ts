/**
 * `/api/status` defaults, end to end through a stub CLI.
 *
 * Round 4 opened with a report that the running server returned a null
 * default model while the daemon plainly had one. It did not reproduce --
 * the check had read `.default` rather than `.defaults`, and the two
 * candidate values happened to coincide, so nothing distinguished "read
 * from the daemon" from "fell back to config".
 *
 * These tests make that distinguishable by construction: the stub CLI
 * reports a model that is DIFFERENT from the one in the bridge config, so
 * an assertion on the response can only pass if the value really came from
 * the facade.
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

/** What the daemon reports. Deliberately NOT the config's default_model. */
const DAEMON_DEFAULT = {
  provider: 'claude-code',
  modelId: 'claude-fable-5',
  thinkingLevel: 'xhigh',
  fastMode: false,
};

/**
 * A stand-in for `aside repl` that answers the settings read with the real
 * sentinel framing and stays silent on everything else.
 */
function stubCli(dir: string, payload: unknown): string {
  const file = path.join(dir, 'stub-aside.mjs');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const script = process.argv[3] || '';
if (script.includes('settings.getAll')) {
  process.stdout.write(
    '<<<ASIDE_JSON' + ${JSON.stringify(JSON.stringify(payload))} + 'ASIDE_JSON>>>\\n',
  );
} else {
  process.stdout.write('<<<ASIDE_JSONnullASIDE_JSON>>>\\n');
}
`,
    { mode: 0o755 },
  );
  return file;
}

async function bootWith(cli: string): Promise<void> {
  fs.writeFileSync(
    env.configPath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(env.configPath, 'utf8')),
      aside_cli: cli,
      // The fallback value, and deliberately different from DAEMON_DEFAULT.
      default_model: 'claude-sonnet-5',
      default_effort: 'high',
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
}

const status = async () =>
  (
    await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(async () => {
  await app?.close();
  env.cleanup();
});

describe('GET /api/status defaults', () => {
  it('reports the DAEMON default, not the bridge config’s', async () => {
    const cli = stubCli(env.root, DAEMON_DEFAULT);
    // Node scripts need an interpreter; point the config at node itself
    // via a tiny shell shim so argv[3] is still the repl script.
    const shim = path.join(env.root, 'shim.sh');
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${cli} "$@"\n`, {
      mode: 0o755,
    });
    await bootWith(shim);

    const body = await status();
    expect(body.defaults.provider).toBe('claude-code');
    expect(body.defaults.modelId).toBe('claude-fable-5');
    expect(body.defaults.modelLabel).toBe('Fable 5');
    expect(body.defaults.effort).toBe('xhigh');
    expect(body.defaults.effortLabel).toBe('Extra High');
    // The config value must NOT have won.
    expect(body.defaults.modelId).not.toBe('claude-sonnet-5');
  });

  /**
   * The payload key is `defaults`, plural. Pinned because reading the
   * singular is exactly the mistake that opened this round.
   */
  it('exposes the defaults under `defaults`, fully populated', async () => {
    const cli = stubCli(env.root, DAEMON_DEFAULT);
    const shim = path.join(env.root, 'shim.sh');
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${cli} "$@"\n`, {
      mode: 0o755,
    });
    await bootWith(shim);

    const body = await status();
    expect(body).toHaveProperty('defaults');
    expect(body).not.toHaveProperty('default');
    for (const key of [
      'provider',
      'modelId',
      'modelLabel',
      'effort',
      'effortLabel',
    ]) {
      expect(body.defaults[key], `defaults.${key}`).toBeTruthy();
    }
  });

  /**
   * An unreachable daemon must still yield a usable payload -- the pills
   * cannot render "null" -- so it falls back to the bridge config.
   */
  it('falls back to the config when the facade cannot be reached', async () => {
    await bootWith('/nonexistent/aside-binary');

    const body = await status();
    expect(body.defaults.modelId).toBe('claude-sonnet-5');
    expect(body.defaults.effort).toBe('high');
    expect(body.defaults.modelLabel).toBe('Sonnet 5');
  });

  it('falls back when the daemon reports no default at all', async () => {
    const cli = stubCli(env.root, null);
    const shim = path.join(env.root, 'shim.sh');
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${cli} "$@"\n`, {
      mode: 0o755,
    });
    await bootWith(shim);

    const body = await status();
    expect(body.defaults.modelId).toBe('claude-sonnet-5');
    expect(body.defaults.provider).toBe('claude-code');
  });
});
