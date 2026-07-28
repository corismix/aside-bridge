/**
 * The instruction block prepended to the first message of a session this
 * app starts.
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
 * The instructions themselves.
 *
 * Exported so a test can assert the two things that must never drift: that
 * it names both native tools, and that the example is valid JSON in the
 * shape `questions.ts` parses.
 */
export const MOBILE_SESSION_PREAMBLE = [
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
  '',
  'The block must contain only JSON. The user taps an option and their',
  'choice arrives as your next message. End the turn after emitting it --',
  'do not keep working while you wait.]',
].join('\n');

/**
 * Prepend the preamble to a new session's first prompt.
 *
 * Only ever applied on session CREATE. A follow-up does not repeat it: the
 * instruction is already in the session's context, and re-sending it on
 * every message would both waste tokens and read to the model as a fresh
 * system directive interrupting the conversation.
 */
export function withPreamble(text: string): string {
  const body = String(text ?? '').trim();
  return body ? `${MOBILE_SESSION_PREAMBLE}\n\n${body}` : MOBILE_SESSION_PREAMBLE;
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
