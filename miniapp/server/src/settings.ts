/**
 * The mini app's own settings.
 *
 * Scope is deliberately narrow: these are defaults for sessions THIS app
 * creates, stored in this app's own file. Nothing here writes to Aside's
 * global settings. That is not squeamishness -- `aside.settings` is
 * account-wide, so a default changed from a phone would silently retarget
 * every session the owner starts in the desktop app too, and there is no
 * way to signal that from a settings row on a 400px screen.
 *
 * Aside's own account-level values are still READ (the model pills already
 * mirror `aside.settings.getAll().defaultModel`), and the settings screen
 * shows them as information. The line is read-only, and it holds.
 *
 * The file lives beside the bridge config, in the same state directory as
 * the JWT secret, and never in the repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EFFORT_LEVELS, type EffortLevel } from './config.js';
import { isPermissionMode, type PermissionMode } from './permission.js';

export interface MiniappSettings {
  /** Provider id for new sessions, e.g. `claude-code`. Empty = Aside's own. */
  defaultProvider: string;
  /** Model id for new sessions. Empty = Aside's own default. */
  defaultModelId: string;
  /** Reasoning effort for new sessions. Empty = the server's config default. */
  defaultEffort: EffortLevel | '';
  /**
   * Permission mode for new sessions, or null to leave the daemon's own
   * default alone.
   *
   * Null is the shipped value and stays the shipped value. The existing
   * safety posture is that this app does not widen permissions unless the
   * owner asks: `MINIAPP_GRANT_FULL_ACCESS` is the env gate for that, and a
   * settings row must not become a second, quieter way to flip it. Choosing
   * `full-access` here is an explicit act by the owner and is recorded as
   * one; not choosing anything still means "whatever the daemon does".
   */
  defaultPermissionMode: PermissionMode | null;
  /** `runtimeConfig.finalConfirm` for new sessions; null leaves it alone. */
  defaultFinalConfirm: boolean | null;
}

export const DEFAULT_SETTINGS: MiniappSettings = {
  defaultProvider: '',
  defaultModelId: '',
  defaultEffort: '',
  defaultPermissionMode: null,
  defaultFinalConfirm: null,
};

export function defaultSettingsPath(stateDir: string): string {
  return (
    process.env.MINIAPP_SETTINGS_PATH ||
    path.join(stateDir, 'miniapp-settings.json')
  );
}

function asEffort(value: unknown): EffortLevel | '' {
  return EFFORT_LEVELS.includes(value as EffortLevel)
    ? (value as EffortLevel)
    : '';
}

/**
 * Coerce whatever is on disk (or in a request body) into a valid settings
 * object.
 *
 * Total by construction: an unreadable file, a hand-edited one, or a client
 * sending nonsense all land on the defaults rather than on a half-applied
 * state. A model id is accepted as-is because the catalog is user-extensible
 * through the bridge config and validating against the built-in table would
 * reject the owner's own additions.
 */
export function normaliseSettings(raw: unknown): MiniappSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  const record = raw as Record<string, unknown>;
  return {
    defaultProvider: String(record.defaultProvider ?? '').trim(),
    defaultModelId: String(record.defaultModelId ?? '').trim(),
    defaultEffort: asEffort(record.defaultEffort),
    defaultPermissionMode: isPermissionMode(record.defaultPermissionMode)
      ? record.defaultPermissionMode
      : null,
    defaultFinalConfirm:
      typeof record.defaultFinalConfirm === 'boolean'
        ? record.defaultFinalConfirm
        : null,
  };
}

/**
 * Apply a partial update.
 *
 * Only keys the caller actually sent are touched, so a client that knows
 * about one field cannot blank the others by omitting them -- which is the
 * failure mode of merging a normalised whole-object read.
 */
export function mergeSettings(
  current: MiniappSettings,
  patch: unknown,
): MiniappSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return current;
  }
  const record = patch as Record<string, unknown>;
  const next: MiniappSettings = { ...current };

  if ('defaultProvider' in record) {
    next.defaultProvider = String(record.defaultProvider ?? '').trim();
  }
  if ('defaultModelId' in record) {
    next.defaultModelId = String(record.defaultModelId ?? '').trim();
  }
  if ('defaultEffort' in record) {
    next.defaultEffort = asEffort(record.defaultEffort);
  }
  if ('defaultPermissionMode' in record) {
    next.defaultPermissionMode = isPermissionMode(record.defaultPermissionMode)
      ? record.defaultPermissionMode
      : null;
  }
  if ('defaultFinalConfirm' in record) {
    next.defaultFinalConfirm =
      typeof record.defaultFinalConfirm === 'boolean'
        ? record.defaultFinalConfirm
        : null;
  }
  return next;
}

/**
 * Load-on-read, write-through store.
 *
 * Held in memory after the first read because the create-session path
 * consults it and that path is already slow enough.
 */
export class SettingsStore {
  private cached: MiniappSettings | null = null;

  constructor(private readonly file: string) {}

  read(): MiniappSettings {
    if (this.cached) return this.cached;
    try {
      this.cached = normaliseSettings(
        JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown,
      );
    } catch {
      // No file yet is the first-run state, not an error.
      this.cached = { ...DEFAULT_SETTINGS };
    }
    return this.cached;
  }

  /** Apply a partial update and persist it. Returns the new whole. */
  write(patch: unknown): MiniappSettings {
    const next = mergeSettings(this.read(), patch);
    this.cached = next;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 0600 for the same reason the JWT secret is: this is the owner's
      // private configuration and nothing else on the machine needs it.
      fs.writeFileSync(this.file, JSON.stringify(next, null, 2), {
        mode: 0o600,
      });
    } catch {
      // An unwritable state directory must not fail the request; the
      // setting still applies for the life of this process.
    }
    return next;
  }
}

/**
 * The `-m provider/modelId` argument a new session should get, or undefined
 * to let the CLI pick.
 *
 * A client-supplied model always wins: the composer's pills are what the
 * user can see, and a stored default must never override the choice they
 * just made on screen.
 */
export function resolveNewSessionModel(
  settings: MiniappSettings,
  requested: unknown,
): string | undefined {
  const explicit = typeof requested === 'string' ? requested.trim() : '';
  if (explicit) return explicit;
  if (settings.defaultProvider && settings.defaultModelId) {
    return `${settings.defaultProvider}/${settings.defaultModelId}`;
  }
  return undefined;
}
