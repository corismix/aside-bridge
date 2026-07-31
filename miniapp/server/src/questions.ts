/**
 * Questions the agent puts to the user, from both places they can come.
 *
 * There are two, and the difference between them is the whole design here.
 *
 * 1. The NATIVE tools -- `ask_user_question` and
 *    `request_action_confirmation`. The daemon suspends the session on
 *    these and waits for an answer over its own authenticated channel. That
 *    channel is the desktop sidepanel and nothing else: verified today
 *    against the live CLI, a follow-up `aside exec --session <id> "<text>"`
 *    blocks forever, stdin to the driver process is ignored, and the
 *    `aside.sessions` repl facade exposes no answer/respond method at all
 *    (its surface is constructor, current, list, get, messages, messageRows,
 *    childSessions, update, archive, unarchive, markRead, markUnread). So a
 *    pending native question CANNOT be answered from a phone, and the honest
 *    thing is to render it read-only and say where to answer it.
 *
 * 2. The SOFT marker -- `[[QUESTION]] {json} [[/QUESTION]]`, which sessions
 *    this app starts are instructed to use instead (see `preamble.ts`). The
 *    agent ends its turn cleanly and the question is just text in the
 *    transcript, so tapping an option sends an ordinary follow-up message,
 *    which works. It extends bridge.py's `[[APPROVAL]]` protocol rather than
 *    replacing it: the same block is also accepted here so a session the
 *    Python bridge set up renders identically.
 *
 * Both render through one item type, so the UI is the same either way and
 * only `answerable` differs.
 */

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionBlock {
  /** Short heading Aside shows above the question. */
  header: string;
  question: string;
  options: QuestionOption[];
}

/** A rendered artifact line on a confirmation card, e.g. a calendar draft. */
export interface QuestionArtifact {
  type: string;
  /** `key: value` lines, flattened one level. Never the raw JSON. */
  summary: Array<{ label: string; value: string }>;
}

export interface QuestionItem {
  kind: 'question';
  id: string;
  /** `ask` is a multiple-choice question; `confirm` is approve / cancel. */
  variant: 'ask' | 'confirm';
  /** `tool` is a native pending tool; `marker` is our soft protocol. */
  source: 'tool' | 'marker';
  questions: QuestionBlock[];
  artifact?: QuestionArtifact;
  /**
   * `answered` once the transcript carries the result, so history reads as
   * history rather than as a live prompt with dead buttons.
   */
  status: 'pending' | 'answered';
  /** What was answered, when it is known. */
  answer?: string;
  /**
   * True when tapping an option can actually deliver the answer.
   *
   * False for a pending NATIVE tool, for the reason in the header note. The
   * client renders those disabled with an inline "answer this from Aside on
   * your computer" notice rather than offering a button that cannot work.
   */
  answerable: boolean;
}

/** Tools whose calls are a question rather than a step in the timeline. */
export const QUESTION_TOOLS = new Set([
  'ask_user_question',
  'request_action_confirmation',
]);

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = str((item as Record<string, unknown>).label);
    if (!label) continue;
    out.push({
      label,
      description: str((item as Record<string, unknown>).description),
    });
  }
  return out;
}

/**
 * Flatten a confirmation's `artifact.data` into label/value lines.
 *
 * One level only, and objects/arrays are JSON-stringified into a single
 * line rather than expanded: the card is a summary a thumb can read, and
 * the raw JSON is precisely what this whole change exists to stop showing.
 */
export function summariseArtifact(raw: unknown): QuestionArtifact | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const artifact = raw as Record<string, unknown>;
  const data = artifact.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;

  const summary: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
    summary.push({ label: key, value: text.slice(0, 400) });
  }
  if (!summary.length) return undefined;
  return { type: str(artifact.type) || 'artifact', summary };
}

/**
 * The question blocks a native tool call carries, or null when the call is
 * not one of the question tools (or its arguments are unusable).
 */
export function questionsFromToolCall(
  tool: string,
  args: unknown,
): { variant: 'ask' | 'confirm'; questions: QuestionBlock[]; artifact?: QuestionArtifact } | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;

  if (tool === 'ask_user_question') {
    const raw = record.questions;
    if (!Array.isArray(raw)) return null;
    const questions: QuestionBlock[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const question = str(entry.question);
      if (!question) continue;
      questions.push({
        header: str(entry.header) || 'Question',
        question,
        options: readOptions(entry.options),
      });
    }
    return questions.length ? { variant: 'ask', questions } : null;
  }

  if (tool === 'request_action_confirmation') {
    const title = str(record.title);
    const message = str(record.message);
    if (!title && !message) return null;
    return {
      variant: 'confirm',
      questions: [
        {
          header: title || 'Confirm this action',
          question: message || title,
          // Aside's own confirmation card offers exactly these two.
          options: [
            { label: 'Approve', description: 'Go ahead with this action' },
            { label: 'Cancel', description: "Don't do it" },
          ],
        },
      ],
      artifact: summariseArtifact(record.artifact),
    };
  }

  return null;
}

/**
 * The soft protocol, in both spellings.
 *
 * `[[QUESTION]]` carries JSON, which is what a structured multiple-choice
 * question needs. `[[APPROVAL]]` is bridge.py's existing line-oriented block
 * (`Action:` / `Details:`) and is kept working verbatim -- a session the
 * Python bridge configured must not start rendering its approval requests
 * as plain text just because this app learned a richer format.
 */
const QUESTION_BLOCK = /\[\[QUESTION\]\]([\s\S]*?)\[\[\/QUESTION\]\]/i;
const APPROVAL_BLOCK = /\[\[APPROVAL\]\]([\s\S]*?)\[\[\/APPROVAL\]\]/i;

export interface MarkerParse {
  variant: 'ask' | 'confirm';
  questions: QuestionBlock[];
  artifact?: QuestionArtifact;
  /** The text with the marker block removed, so it is never shown raw. */
  rest: string;
}

/**
 * Pull a soft-protocol question out of assistant text.
 *
 * Returns null when there is no marker, which is the overwhelmingly common
 * case, so this is one regex test on the hot path.
 */
export function parseQuestionMarker(text: string): MarkerParse | null {
  const raw = String(text || '');

  const question = QUESTION_BLOCK.exec(raw);
  if (question) {
    const rest = (raw.slice(0, question.index) + raw.slice(question.index + question[0].length)).trim();
    const parsed = parseQuestionJson(question[1]);
    // A malformed body is left as text rather than rendered as an empty
    // card: showing nothing would lose the agent's actual message.
    if (!parsed) return null;
    return { ...parsed, rest };
  }

  const approval = APPROVAL_BLOCK.exec(raw);
  if (approval) {
    const rest = (raw.slice(0, approval.index) + raw.slice(approval.index + approval[0].length)).trim();
    const block = parseApprovalBlock(approval[1]);
    if (!block) return null;
    return { ...block, rest };
  }

  return null;
}

function parseQuestionJson(body: string): Omit<MarkerParse, 'rest'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(body || '').trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  // The same JSON shape as the native tools, so an agent only has one
  // format to learn and the renderer only has one to draw.
  const asAsk = questionsFromToolCall('ask_user_question', record);
  if (asAsk) return asAsk;
  const asConfirm = questionsFromToolCall('request_action_confirmation', record);
  if (asConfirm) return asConfirm;

  // A single bare question is also accepted, because it is what an agent
  // writes when it has one thing to ask.
  const question = str(record.question);
  if (!question) return null;
  return {
    variant: 'ask',
    questions: [
      {
        header: str(record.header) || 'Question',
        question,
        options: readOptions(record.options),
      },
    ],
  };
}

/** bridge.py's `Action:` / `Details:` block, as a confirmation card. */
function parseApprovalBlock(body: string): Omit<MarkerParse, 'rest'> | null {
  let action = '';
  let details = '';
  for (const line of String(body || '').split('\n')) {
    const trimmed = line.trim();
    if (/^action\s*:/i.test(trimmed)) action = trimmed.replace(/^action\s*:/i, '').trim();
    else if (/^details\s*:/i.test(trimmed)) {
      details = trimmed.replace(/^details\s*:/i, '').trim();
    } else if (details && trimmed) details += ` ${trimmed}`;
  }
  if (!action && !details) return null;
  return {
    variant: 'confirm',
    questions: [
      {
        header: action || 'Approve this action',
        question: details || action,
        options: [
          { label: 'Approve', description: 'Go ahead with this action' },
          { label: 'Deny', description: "Don't do it" },
        ],
      },
    ],
  };
}

/**
 * What a tapped option sends back as an ordinary message.
 *
 * The header is included because a multi-question card produces several of
 * these and the agent has to be able to tell them apart.
 *
 * Deliberately NOT the bulleted `- <header>: <label>` the native tool's own
 * result uses. That leading dash made every answer look like a command-line
 * flag to the CLI's argument parser, and the follow-up turn died with
 * `unknown option '- Color test: Red'` -- caught in live E2E. The real fix
 * is the `--` terminator at both spawn sites (see `PROMPT_TERMINATOR` in
 * exec.ts), and this is the belt to that pair of braces: it also reads
 * better in the transcript, where the answer is a message rather than a
 * list item.
 */
export function answerMessage(header: string, label: string): string {
  const heading = String(header || '').trim();
  const choice = String(label || '').trim();
  return heading ? `${heading}: ${choice}` : choice;
}

/** The newest pending question nobody can answer from here, or null. */
export function pendingNativeQuestion(
  items: Array<{ kind: string } & Partial<QuestionItem>>,
): QuestionItem | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'question') continue;
    if (item.source !== 'tool') continue;
    if (item.status !== 'pending' || item.answerable) continue;
    return item as QuestionItem;
  }
  return null;
}

/** Keep the seed a seed: a preface, not a replayed transcript. */
const SEED_FIELD_CHARS = 600;

function clip(text: unknown, limit = SEED_FIELD_CHARS): string {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
}

/**
 * The first message of a NEW session that continues a stuck one.
 *
 * A session suspended on a native question tool cannot be unstuck -- not
 * from here, not by any request this server can make. Leaving the user on
 * a read-only banner is honest and useless, so the way forward is a fresh
 * session that starts already knowing what was asked and what the answer
 * is. The stuck one is left exactly as it is.
 *
 * Deliberately a PREFACE and not a replay: carrying the whole transcript
 * over would cost the new session most of its context window to reproduce
 * a conversation the agent can just be told about. The question, the
 * chosen answer, and the original ask are what make the next turn useful.
 */
export function recoveryPrompt(input: {
  question?: QuestionItem | null;
  /** What the user tapped, or typed in their own words. */
  answer?: string;
  /** The stuck session's own first message, when it is cheap to read. */
  firstMessage?: string;
}): string {
  const lines: string[] = [
    'Continuing from a session that got stuck on a prompt only Aside on ' +
      'the desktop could answer. That session cannot be resumed, so here ' +
      'is where it got to.',
  ];

  const opening = clip(input.firstMessage);
  if (opening) lines.push('', `What I originally asked: ${opening}`);

  const block = input.question?.questions?.[0];
  if (block) {
    const heading = clip(block.header, 200);
    const asked = clip(block.question);
    lines.push('', `Where it stopped: ${heading ? `${heading} -- ` : ''}${asked}`);
    const options = (block.options || [])
      .map((option) => clip(option.label, 120))
      .filter(Boolean);
    if (options.length) lines.push(`Options offered: ${options.join(' / ')}`);
  }

  const answer = clip(input.answer);
  if (answer) lines.push('', `My answer: ${answer}`);

  lines.push('', 'Pick up from there.');
  return lines.join('\n');
}
