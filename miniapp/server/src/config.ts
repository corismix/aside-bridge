/**
 * Runtime configuration for the Aside Mini App server.
 *
 * The bridge's own config.json is the source of truth (bot token, the
 * single allowlisted Telegram user id, model/effort defaults). We only
 * ever read it -- the live Python bridge owns writing it.
 *
 * The bot token is used for exactly one thing: computing the HMAC secret
 * key for Telegram initData validation. It never leaves this process and
 * is never logged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Every effort level Aside itself names, in its own order.
 *
 * `max` is here because Aside's UI and settings use it, but note
 * SENDABLE_EFFORT_LEVELS below: the CLI will not accept it.
 */
export const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultrabrowse: 'Ultrabrowse',
};

/**
 * What `aside exec --effort` actually accepts. Verified against the CLI:
 *
 *   $ aside exec --effort max "…"
 *   error: option '--effort <effort>' argument 'max' is invalid.
 *          Allowed choices are off, minimal, low, medium, high, xhigh,
 *          ultrabrowse.
 *
 * So "Max" appears in Aside's own Reasoning popover but is unsendable
 * through this transport. It is deliberately absent from the picker rather
 * than being silently remapped onto xhigh, which would lie about what the
 * turn ran at.
 */
export const EFFORT_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultrabrowse',
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * The Reasoning popover, in Aside's order. Off and Minimal are accepted by
 * the API but are not in Aside's own menu for these models, so they are
 * not offered here either.
 */
export const EFFORT_MENU: EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'ultrabrowse',
];

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] || effort;
}

const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
};

/** The `miniapp` section of the bridge config. All of it is optional. */
export interface MiniappSection {
  /** `"cloudflared"` manages a public HTTPS tunnel; `"none"` stays local. */
  tunnel: 'cloudflared' | 'none';
  /**
   * Register the Telegram menu button at the tunnel URL.
   *
   * OFF by default and deliberately so: the bot is live in production, and
   * flipping this is the owner's call, not the installer's.
   */
  autoRegisterMenu: boolean;
  port: number;
  /** Where cloudflared and the runtime state live -- never in the repo. */
  stateDir: string;
  /**
   * A cloudflared the user installed themselves. Set it and nothing is
   * downloaded -- which is the documented way past a checksum failure
   * (audit M-6), rather than a flag that turns the check off.
   */
  cloudflaredPath: string;
  logPath: string;
  /** Cap on the log file before it is rotated to `<name>.1`. */
  logMaxBytes: number;
}

export interface MiniappConfig {
  /** Telegram bot token. HMAC key material only -- never logged, never sent. */
  botToken: string;
  /** The only Telegram user id allowed to use this server. */
  allowedUserId: number;
  defaultModel: string;
  defaultEffort: EffortLevel;
  modelAliases: Record<string, string>;
  sessionsDir: string;
  asideCli: string;
  credentialsPath: string;
  /** Daemon SQLite db, read-only, for per-session permission mode + model. */
  stateDbPath: string;
  /**
   * Where bridge.py saves photos and documents that arrive over Telegram.
   * Read-only here, and one of the three roots the local-image route will
   * serve from -- an answer that references a photo the owner texted in is
   * referencing a path under this directory.
   */
  mediaDir: string;
  /** Optional `models` section merged over the built-in provider catalog. */
  modelCatalogOverrides: Record<string, unknown>;
  execTimeoutMs: number;
  port: number;
  /** Where the HS256 signing secret is persisted (chmod 600, outside the repo). */
  secretPath: string;
  miniapp: MiniappSection;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function configPath(): string {
  return expandHome(
    process.env.MINIAPP_CONFIG ||
      '~/.aside/u/0/telegram-bridge/config.json',
  );
}

function asEffort(value: unknown, fallback: EffortLevel): EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel)
    ? (value as EffortLevel)
    : fallback;
}

export function loadConfig(): MiniappConfig {
  const file = configPath();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `cannot read miniapp config at ${file}: ${(err as Error).message}`,
    );
  }

  const botToken = String(raw.token || '');
  if (!botToken) throw new Error(`config ${file} has no "token"`);

  const allowedUserId = Number(raw.chat_id);
  if (!Number.isFinite(allowedUserId) || allowedUserId === 0) {
    throw new Error(`config ${file} has no usable numeric "chat_id"`);
  }

  const sessionsDir = expandHome(
    process.env.MINIAPP_SESSIONS_DIR ||
      String(raw.sessions_dir || '~/.aside/u/0/sessions'),
  );
  const asideCli = expandHome(
    process.env.MINIAPP_ASIDE_CLI ||
      String(raw.aside_cli || '~/.aside/cli/Aside CLI.app/Contents/MacOS/aside'),
  );
  const secretPath = expandHome(
    process.env.MINIAPP_SECRET_PATH ||
      path.join(path.dirname(file), 'miniapp-secret.json'),
  );
  const credentialsPath = expandHome(
    process.env.MINIAPP_CREDENTIALS ||
      String(raw.credentials_path || '~/.aside/u/0/credentials.json'),
  );
  const stateDbPath = expandHome(
    process.env.MINIAPP_STATE_DB ||
      String(raw.state_db_path || '~/.aside/u/0/state.db'),
  );

  // bridge.py writes media next to its own config, which is also where
  // this app's state lives.
  const mediaDir = expandHome(
    process.env.MINIAPP_MEDIA_DIR ||
      String(raw.media_dir || path.join(path.dirname(file), 'media')),
  );

  const section = (raw.miniapp as Record<string, unknown>) || {};
  const stateDir = expandHome(
    String(section.state_dir || path.dirname(file)),
  );
  const port = Number(
    process.env.MINIAPP_PORT || section.port || 8790,
  );

  /**
   * Env kill-switches for the two side-effecting features.
   *
   * These exist because both are process-global in effect but per-process
   * in configuration: `setChatMenuButton` has no notion of "which server",
   * so a SECOND instance started from the same config -- a dev run, a test
   * server on another port -- silently repoints the owner's live Mini App
   * at its own throwaway tunnel and breaks it for everyone. That is a
   * genuine foot-gun rather than a hypothetical one; it happened.
   *
   * `MINIAPP_TUNNEL=none` and `MINIAPP_AUTO_REGISTER_MENU=0` let a second
   * instance opt out without editing (or copying) the real config, which
   * carries the bot token.
   */
  const tunnelOverride = process.env.MINIAPP_TUNNEL;
  const wantsTunnel =
    tunnelOverride === 'none'
      ? false
      : tunnelOverride === 'cloudflared' || section.tunnel === 'cloudflared';
  const menuOverride = process.env.MINIAPP_AUTO_REGISTER_MENU;

  const miniapp: MiniappSection = {
    tunnel: wantsTunnel ? 'cloudflared' : 'none',
    // Never defaulted on, and always off when the env says so. See
    // MiniappSection.
    autoRegisterMenu:
      menuOverride === '0'
        ? false
        : menuOverride === '1' || section.auto_register_menu === true,
    port,
    stateDir,
    cloudflaredPath: expandHome(
      String(process.env.MINIAPP_CLOUDFLARED_PATH ||
        section.cloudflared_path || ''),
    ),
    logPath: expandHome(
      String(section.log_path || path.join(stateDir, 'miniapp.log')),
    ),
    logMaxBytes: Number(section.log_max_bytes || 5 * 1024 * 1024),
  };

  return {
    botToken,
    allowedUserId,
    defaultModel: String(raw.default_model || 'claude-sonnet-5'),
    defaultEffort: asEffort(raw.default_effort, 'high'),
    modelAliases: (raw.model_aliases as Record<string, string>) ||
      DEFAULT_MODEL_ALIASES,
    sessionsDir,
    asideCli,
    credentialsPath,
    stateDbPath,
    mediaDir,
    modelCatalogOverrides: (raw.models as Record<string, unknown>) || {},
    execTimeoutMs: Number(raw.exec_timeout_seconds || 1200) * 1000,
    port,
    secretPath,
    miniapp,
  };
}

/**
 * Load (or first-run generate) the 32-byte HS256 secret used to sign
 * session JWTs. Lives next to the bridge config, chmod 600, never in
 * the repo.
 */
export function loadOrCreateJwtSecret(secretPath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretPath, 'utf8')) as {
      secret?: string;
    };
    if (parsed.secret && parsed.secret.length >= 32) return parsed.secret;
  } catch {
    // fall through to generation
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(
    secretPath,
    JSON.stringify({ secret, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(secretPath, 0o600);
  return secret;
}
