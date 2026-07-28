/**
 * Per-session permission mode and the final-confirm toggle.
 *
 * Reads come from state.db (read-only, see statedb.ts). Writes go through
 * the sanctioned facade: `aside.sessions.update(id, {...})`, which is the
 * daemon's own validated entry point.
 *
 * Two things were checked against the live daemon before this was written,
 * because guessing either would corrupt the owner's real sessions:
 *
 *  - `permissionMode` is a Zod enum of exactly `read-only` | `guard` |
 *    `full-access`. Anything else is rejected outright by the daemon, so
 *    the same three are the only values this module will send.
 *  - `runtimeConfig` DOES deep-merge: sending `{finalConfirm:false}` alone
 *    left `proactiveMode`, `strictModelSelection`, `workingDirs` and the
 *    rest untouched in the row. Verified on a throwaway session.
 *
 * Even so, the write below reads the current config and sends the FULL
 * object back with one key changed. Merge semantics are an undocumented
 * property of a binary that updates itself; a replace-shaped daemon would
 * silently wipe the owner's working directories, and read-modify-write is
 * correct under both. There is a test pinning that no sibling key is lost.
 *
 * Honest scope: a change binds on the next `aside exec` spawn -- i.e. the
 * next message. It does not reach into a turn already in flight, and
 * nothing here pretends otherwise.
 */
import type { FacadeCache } from './facade.js';

export const PERMISSION_MODES = ['read-only', 'guard', 'full-access'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

/** The label Aside puts on each mode, in its own popover order. */
export const PERMISSION_MENU: Array<{ id: PermissionMode; label: string }> = [
  { id: 'read-only', label: 'Read only' },
  { id: 'guard', label: 'Guard' },
  { id: 'full-access', label: 'Full access' },
];

export interface PermissionUpdate {
  mode?: PermissionMode;
  finalConfirm?: boolean;
}

/**
 * Merge one key into a runtime config without losing the rest.
 *
 * Exported so the "no sibling key is lost" guarantee is testable without a
 * daemon in the loop.
 */
export function mergeRuntimeConfig(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(current || {}), ...patch };
}

/** JS literal for a value about to be interpolated into repl code. */
function lit(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Build the `aside repl` expression for an update.
 *
 * Both fields go in one call so a two-field change cannot half-apply.
 * Exported for tests: the expression is the whole contract with the daemon.
 */
export function updateExpression(
  sessionId: string,
  patch: { permissionMode?: PermissionMode; runtimeConfig?: Record<string, unknown> },
): string {
  return `aside.sessions.update(${lit(sessionId)}, ${lit(patch)})`;
}

export interface PermissionWriter {
  /** Current runtime config for the session, or null when unreadable. */
  readRuntimeConfig: (id: string) => Promise<Record<string, unknown> | null>;
  facade: FacadeCache;
}

/**
 * Apply a permission change. Returns what was actually sent, so the caller
 * can log or echo it without re-deriving.
 */
export async function applyPermission(
  writer: PermissionWriter,
  sessionId: string,
  update: PermissionUpdate,
): Promise<{ permissionMode?: PermissionMode; runtimeConfig?: Record<string, unknown> }> {
  const patch: {
    permissionMode?: PermissionMode;
    runtimeConfig?: Record<string, unknown>;
  } = {};

  if (update.mode !== undefined) patch.permissionMode = update.mode;

  if (update.finalConfirm !== undefined) {
    const current = await writer.readRuntimeConfig(sessionId);
    patch.runtimeConfig = mergeRuntimeConfig(current, {
      finalConfirm: Boolean(update.finalConfirm),
    });
  }

  if (!Object.keys(patch).length) return patch;

  await writer.facade.mutate(updateExpression(sessionId, patch));
  return patch;
}
