/**
 * The env kill-switches for the tunnel and the menu button.
 *
 * Both features are process-global in effect but per-process in
 * configuration: `setChatMenuButton` has no notion of "which server", so a
 * second instance started from the same config repoints the owner's live
 * Mini App at its own throwaway tunnel. These overrides are what let a dev
 * or test instance run without doing that, and they are pinned here
 * because the failure is invisible from inside the process that causes it.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configCandidates, loadConfig } from '../src/config.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv | undefined;

/**
 * These two variables are what the project's own documented test command
 * sets (`MINIAPP_PORT=8792 MINIAPP_TUNNEL=none MINIAPP_AUTO_REGISTER_MENU=0`,
 * so a test run cannot repoint the live bot). Reading them off the ambient
 * environment made this file fail under exactly that command: the suite was
 * only green when run in a way the project tells you not to. Each case now
 * owns the variables it is about, and the outer environment is restored.
 */
const OVERRIDES = ['MINIAPP_TUNNEL', 'MINIAPP_AUTO_REGISTER_MENU'] as const;
let saved: Array<string | undefined> = [];

beforeEach(() => {
  saved = OVERRIDES.map((name) => process.env[name]);
  for (const name of OVERRIDES) delete process.env[name];
});

afterEach(() => {
  OVERRIDES.forEach((name, index) => {
    const value = saved[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  env?.cleanup();
  env = undefined;
});

const withMiniapp = (section: Record<string, unknown>) => {
  env = makeTestEnv({ miniapp: section });
  return loadConfig();
};

describe('tunnel + menu kill-switches', () => {
  it('honours the config when no override is set', () => {
    const config = withMiniapp({ tunnel: 'cloudflared', auto_register_menu: true });
    expect(config.miniapp.tunnel).toBe('cloudflared');
    expect(config.miniapp.autoRegisterMenu).toBe(true);
  });

  it('MINIAPP_TUNNEL=none disables a configured tunnel', () => {
    process.env.MINIAPP_TUNNEL = 'none';
    const config = withMiniapp({ tunnel: 'cloudflared', auto_register_menu: true });
    expect(config.miniapp.tunnel).toBe('none');
  });

  /** The important one: no Bot API call from a second instance. */
  it('MINIAPP_AUTO_REGISTER_MENU=0 disables menu registration', () => {
    process.env.MINIAPP_AUTO_REGISTER_MENU = '0';
    const config = withMiniapp({ tunnel: 'cloudflared', auto_register_menu: true });
    expect(config.miniapp.autoRegisterMenu).toBe(false);
  });

  it('still defaults menu registration OFF when unconfigured', () => {
    expect(withMiniapp({ tunnel: 'cloudflared' }).miniapp.autoRegisterMenu).toBe(
      false,
    );
  });

  it('lets an override turn either on for a deliberate run', () => {
    process.env.MINIAPP_TUNNEL = 'cloudflared';
    process.env.MINIAPP_AUTO_REGISTER_MENU = '1';
    const config = withMiniapp({});
    expect(config.miniapp.tunnel).toBe('cloudflared');
    expect(config.miniapp.autoRegisterMenu).toBe(true);
  });
});

/**
 * Where the bridge config is looked for.
 *
 * `setup.py` writes config.json into the checkout, but this server only
 * ever looked at `~/.aside/u/0/bridge/config.json`. A user who
 * had just finished setup and ran the documented `npm start` was told no
 * config existed. Both locations are searched now, checkout first.
 */
describe('config discovery', () => {
  let savedConfig: string | undefined;

  beforeEach(() => {
    savedConfig = process.env.MINIAPP_CONFIG;
  });

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.MINIAPP_CONFIG;
    else process.env.MINIAPP_CONFIG = savedConfig;
  });

  it('honours MINIAPP_CONFIG above everything else', () => {
    process.env.MINIAPP_CONFIG = '/tmp/elsewhere/config.json';
    expect(configCandidates()).toEqual(['/tmp/elsewhere/config.json']);
  });

  it('falls back to the checkout first, then the ~/.aside path', () => {
    delete process.env.MINIAPP_CONFIG;
    // test/ sits the same three levels below the repo root that src/ and
    // dist/ do, so this is the same root the implementation resolves.
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../..',
    );
    expect(configCandidates()).toEqual([
      path.join(repoRoot, 'config.json'),
      path.join(os.homedir(), '.aside/u/0/bridge/config.json'),
    ]);
  });
});
