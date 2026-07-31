/**
 * The instruction block prepended to the first message of a session this
 * app starts, and the one-line reminder that rides on every follow-up.
 *
 * It exists for exactly one reason, and it is a correctness fix rather than
 * a style preference: the native `ask_user_question` and
 * `request_action_confirmation` tools suspend the session until they are
 * answered over the daemon's own authenticated channel, and that channel is
 * the desktop sidepanel. From a phone there is no way to answer one --
 * checked against the live CLI today, in every form: a follow-up `aside exec
 * --session <id>` blocks indefinitely, writing to the driver's stdin does
 * nothing, and the repl's `aside.sessions` facade has no answer method. The
 * session sits in `status=suspended` and the driver process hangs forever.
 *
 * So a mobile-driven session is told not to call those tools, and to emit a
 * `[[QUESTION]]` block and END THE TURN instead. That block renders as the
 * same card the native tool would have, and tapping an option is an
 * ordinary follow-up message -- which works precisely because the turn
 * ended.
 *
 * The format is a superset of bridge.py's existing `[[APPROVAL]]` protocol,
 * which is still accepted (see `questions.ts`), so the two transports agree.
 *
 * Kept short on purpose: it rides on every new session's first prompt and
 * competes with the user's actual message for the model's attention.
 */

export const QUESTION_MARKER_OPEN = '[[QUESTION]]';
export const QUESTION_MARKER_CLOSE = '[[/QUESTION]]';

/**
 * Options both the preamble and the follow-up reminder take.
 *
 * `strictConfirm` is what the Mini App's "Confirm before acting" switch
 * now means. It used to write `runtimeConfig.finalConfirm = true`, which
 * makes the daemon inject a SYSTEM-level instruction REQUIRING
 * `request_action_confirmation` before external actions -- outranking this
 * preamble and guaranteeing a bricked session the first time the agent
 * touches anything outside the machine. So the switch stopped doing that
 * (see `app.ts`) and became a stronger line in this text instead: same
 * intent, expressed in a protocol a phone can actually answer.
 */
export interface PreambleOptions {
  /** Require a soft confirm block before any external/irreversible action. */
  strictConfirm?: boolean;
}

/**
 * The extra sentence the switch adds.
 *
 * Placed INSIDE the block, before its closing sentence, so `PREAMBLE_RE`
 * below strips both variants with one pattern.
 */
export const STRICT_CONFIRM_LINE = [
  'Confirm-before-acting is ON for this session: emit one of these blocks',
  'and wait for the reply before ANY external or irreversible action, with',
  'no exceptions -- not the native confirmation tool, which cannot be',
  'answered from here.',
].join('\n');

const PREAMBLE_HEAD = [
  '[Aside Mini App session. You are running for a user on their phone.',
  'They can read this thread and reply, but they CANNOT answer interactive',
  'tool prompts here. So: never call ask_user_question and never call',
  'request_action_confirmation in this session -- both suspend the session',
  'waiting for a desktop-only response, which will never arrive, and the',
  'turn will hang.',
  '',
  'When you need a decision, an approval, or any irreversible or external',
  'action confirmed (sending a message, making a payment, deleting data,',
  'posting publicly), stop, emit one block in exactly this format as the',
  'END of your turn, and do not act until the reply arrives:',
  '',
  `${QUESTION_MARKER_OPEN}`,
  '{"questions":[{"header":"Short heading","question":"What you need to know",',
  '"options":[{"label":"Option A","description":"What this means"},',
  '{"label":"Option B","description":"What this means"}]}]}',
  `${QUESTION_MARKER_CLOSE}`,
].join('\n');

const PREAMBLE_TAIL = [
  'The block must contain only JSON. The user taps an option and their',
  'choice arrives as your next message. End the turn after emitting it --',
  'do not keep working while you wait.]',
].join('\n');

/** Build the block, with or without the strict-confirm sentence. */
export function buildPreamble(options: PreambleOptions = {}): string {
  const middle = options.strictConfirm ? `\n${STRICT_CONFIRM_LINE}\n` : '';
  return `${PREAMBLE_HEAD}\n${middle}\n${PREAMBLE_TAIL}`;
}

/**
 * The instructions themselves, in their default form.
 *
 * Exported so a test can assert the two things that must never drift: that
 * it names both native tools, and that the example is valid JSON in the
 * shape `questions.ts` parses.
 */
export const MOBILE_SESSION_PREAMBLE = buildPreamble();

/**
 * Prepend the preamble to a new session's first prompt.
 *
 * Only ever applied on session CREATE. Follow-ups get the one-line
 * `MOBILE_FOLLOWUP_REMINDER` below rather than the whole block.
 */
export function withPreamble(text: string, options: PreambleOptions = {}): string {
  const body = String(text ?? '').trim();
  const block = buildPreamble(options);
  return body ? `${block}\n\n${body}` : block;
}

/**
 * The one-line reminder appended to every follow-up message.
 *
 * The preamble rides on the first message only, and that is not enough.
 * Long sessions get compacted and the instruction is exactly the kind of
 * housekeeping a summariser drops; low-effort and non-Claude models drift
 * back to the system prompt's default of calling `ask_user_question`
 * sooner still. A session that loses the instruction bricks on the next
 * question, and nothing about it is recoverable.
 *
 * So it goes on EVERY follow-up rather than every Nth. The cleverness of a
 * throttle buys a few dozen tokens a turn and pays for it with a failure
 * mode that only shows up on exactly the long sessions the throttle was
 * meant to help. It is appended, not prepended, so it never becomes the
 * first thing a dash-sensitive argv parser sees -- see `PROMPT_TERMINATOR`
 * in exec.ts.
 */
export const MOBILE_FOLLOWUP_REMINDER =
  '[Reminder: mobile session -- never call ask_user_question or ' +
  'request_action_confirmation; ask with a [[QUESTION]] {json} ' +
  '[[/QUESTION]] block and end the turn.]';

/** The same line, with the confirm-before-acting clause. */
export const STRICT_FOLLOWUP_REMINDER =
  '[Reminder: mobile session -- never call ask_user_question or ' +
  'request_action_confirmation; ask with a [[QUESTION]] {json} ' +
  '[[/QUESTION]] block and end the turn. Confirm that way before any ' +
  'external or irreversible action.]';

export function reminderFor(options: PreambleOptions = {}): string {
  return options.strictConfirm
    ? STRICT_FOLLOWUP_REMINDER
    : MOBILE_FOLLOWUP_REMINDER;
}

/**
 * Append the reminder to a follow-up prompt.
 *
 * Composes with `promptWithAttachments` by construction: that puts its
 * header at the FRONT, this goes at the BACK, and neither can see the
 * other. An attachments-only message is still just the header plus the
 * reminder, which is a valid prompt.
 */
export function withReminder(text: string, options: PreambleOptions = {}): string {
  const body = String(text ?? '').trim();
  const line = reminderFor(options);
  return body ? `${body}\n\n${line}` : line;
}

/**
 * Strip the preamble back off for display.
 *
 * The same shape as `splitAttachmentHeader`: it has to be in the prompt for
 * the agent, and it must not be in the user's own bubble or in the session
 * list's title. Matching on the opening sentence rather than the whole
 * block, so a future edit to the wording does not start leaking the old one
 * into the UI of sessions already on disk.
 */
const PREAMBLE_RE = /^\[Aside Mini App session\.[\s\S]*?do not keep working while you wait\.\]\s*/;

export function stripPreamble(text: string): string {
  return String(text ?? '').replace(PREAMBLE_RE, '');
}

/**
 * Strip the follow-up reminder back off for display.
 *
 * Anchored to the end because that is where `withReminder` puts it, and
 * matched loosely in the middle for the same reason `PREAMBLE_RE` is: the
 * wording will be edited, and transcripts already on disk must keep
 * rendering cleanly when it is.
 */
const REMINDER_RE = /\s*\[Reminder: mobile session[\s\S]*?end the turn\.[\s\S]*?\]\s*$/;

export function stripReminder(text: string): string {
  return String(text ?? '').replace(REMINDER_RE, '');
}

/**
 * Everything this app adds to a prompt for the agent's benefit, removed.
 *
 * One entry point so a new directive cannot be added to the send path and
 * forgotten on the display path -- which is how the preamble came to leak
 * into session-list titles.
 */
export function stripAgentDirectives(text: string): string {
  return stripReminder(stripPreamble(text));
}

/**
 * Whether a session's first user message shows this app (or bridge.py)
 * started it.
 *
 * Used to decide whether the "Confirm before acting" switch is allowed to
 * write the NATIVE `finalConfirm` flag. On a session driven from a phone it
 * never is -- that flag is the daemon-level mandate to call
 * `request_action_confirmation`, which is the bricking tool. On a session
 * the owner started at their desk, where the sidepanel can answer, the
 * switch keeps its original meaning.
 *
 * Derived from the transcript rather than from a store: the marker is
 * already written into the first prompt, it survives restarts and state
 * files being cleared, and there is nothing to keep in sync.
 */
export const BRIDGE_PERSONA_MARK = 'permanent telegram thread';

export function isMobileSeededText(text: string): boolean {
  const raw = String(text ?? '');
  return (
    /^\s*\[Aside Mini App session\./.test(raw) ||
    raw.toLowerCase().includes(BRIDGE_PERSONA_MARK)
  );
}
