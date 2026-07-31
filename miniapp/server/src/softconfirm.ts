/**
 * Per-session "confirm before acting", the soft way.
 *
 * The daemon has its own flag for this -- `runtimeConfig.finalConfirm` --
 * and on a phone it is actively harmful. Setting it makes the daemon inject
 * a SYSTEM-level instruction REQUIRING `request_action_confirmation` before
 * external actions. That instruction outranks the mobile preamble, so the
 * first time the agent touches anything outside the machine it calls the
 * one tool that suspends the session on a prompt only the desktop sidepanel
 * can answer. The session is then unrecoverable from mobile. That is not a
 * hypothetical: it is one of the ways a real user's session bricked.
 *
 * So on a session driven from a phone the switch writes here instead, and
 * `preamble.ts` turns it into a stronger line in the instruction block and
 * in the follow-up reminder. Same intent, in a protocol a thumb can answer.
 *
 * The native flag is still what the switch means on a session the owner
 * started at their desk; see `app.ts` for where the two paths part.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ceiling on remembered sessions.
 *
 * The owner's sessions directory holds thousands, and this file must not
 * grow with it. Oldest-written entries go first, which is the right order:
 * a session someone still has open is one they toggled recently.
 */
export const MAX_SOFT_CONFIRM_ENTRIES = 500;

export function defaultSoftConfirmPath(stateDir: string): string {
  return (
    process.env.MINIAPP_SOFT_CONFIRM_PATH ||
    path.join(stateDir, 'miniapp-soft-confirm.json')
  );
}

/** Only ids that are on, so the file is a set rather than a tri-state map. */
export class SoftConfirmStore {
  private cached: string[] | null = null;

  constructor(private readonly file: string) {}

  private load(): string[] {
    if (this.cached) return this.cached;
    let ids: string[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        ids = raw.filter((v): v is string => typeof v === 'string' && !!v);
      }
    } catch {
      // No file yet is the first-run state, not an error.
    }
    this.cached = ids;
    return ids;
  }

  has(sessionId: string): boolean {
    return this.load().includes(sessionId);
  }

  set(sessionId: string, on: boolean): void {
    const ids = this.load().filter((id) => id !== sessionId);
    if (on) ids.push(sessionId);
    this.cached = ids.slice(-MAX_SOFT_CONFIRM_ENTRIES);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 0600 for the same reason the settings file is: it is the owner's
      // private configuration and nothing else on the machine needs it.
      fs.writeFileSync(this.file, JSON.stringify(this.cached), { mode: 0o600 });
    } catch {
      // An unwritable state directory must not fail the request; the
      // setting still applies for the life of this process.
    }
  }
}
