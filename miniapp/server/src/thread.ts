/**
 * Turn the daemon's structured transcript into exactly what the Aside
 * sidepanel draws.
 *
 * The sidepanel's shape, and the rules that reproduce it:
 *
 *  - A turn starts at a user message and runs to just before the next one.
 *  - Within a turn, the LAST assistant text part is the answer, rendered as
 *    plain markdown on the page. Everything before it -- tool calls and any
 *    mid-turn commentary -- collapses into one `Worked for <N>m <N>s` fold.
 *  - Thinking parts are never shown. The browser does not surface them and
 *    neither do we.
 *  - Each step's label is `arguments.title` when the tool supplies one
 *    (bash and repl do), otherwise it is derived per tool: file writes read
 *    "Wrote <name> +N -M", reads read "Read <name>", and so on.
 *  - There are no per-step timestamps in the browser, so none are emitted.
 */
import type { FacadeMessage } from './facade.js';
import type { HistoryMessage } from './jsonl.js';
import { splitAttachmentHeader } from './uploads.js';

export type StepIcon =
  | 'terminal'
  | 'globe'
  | 'file'
  | 'search'
  | 'list'
  | 'agent'
  | 'clock'
  | 'bell'
  | 'shield'
  | 'dot';

export interface StepDetail {
  /** The command / code the tool was invoked with, shown monospace. */
  command?: string;
  /** Tool output, truncated -- the client offers "show more". */
  output?: string;
  /** True when `output` was cut short. */
  truncated?: boolean;
}

/**
 * A `subagent` spawn, carrying the key that joins it to a child session.
 *
 * `callId` is the spawn toolCall's own id, which the daemon copies into the
 * child session's `trigger.toolCallId`. That is an exact join, so a parent
 * with several identical-looking spawns still maps each card to the right
 * child.
 */
export interface SubagentSpawn {
  callId: string;
  description: string;
  /** First line of the prompt, shown as the card's one bullet. */
  prompt: string;
  /**
   * Palette slot for the creature's colour -- see `SUBAGENT_PALETTE_SIZE`.
   * Assigned in spawn order, so two siblings never share a colour.
   */
  hue: number;
  /** The child session, once the join has been made. */
  child?: ChildSession;
}

/** A child session of this one, as the daemon's own table has it. */
export interface ChildSession {
  id: string;
  title: string;
  status: string;
  /** The parent spawn toolCall this child came from. */
  toolCallId: string;
  modelLabel: string | null;
  running: boolean;
  /** Same palette slot as the spawn row that created it. */
  hue?: number;
}

/**
 * How many distinct creature colours the client draws.
 *
 * Slots are handed out sequentially in spawn order and wrap past the end,
 * which is the whole point: hashing the toolCall id (what this used to do)
 * gave two of eight subagents the same colour roughly half the time, and
 * the colour exists precisely so you can tell sibling cards apart. Keep in
 * step with `HUES` in `web/src/components/Creature.tsx`.
 */
export const SUBAGENT_PALETTE_SIZE = 8;

export interface FileEditLine {
  /** Line number in the resulting file; null for a removed line. */
  n: number | null;
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

/** The rendered diff behind a `write_file` / `edit_file` row. */
export interface FileEdit {
  mode: 'write' | 'edit';
  path: string;
  name: string;
  lines: FileEditLine[];
  /** True when `lines` was cut at FILE_LINE_LIMIT. */
  truncated: boolean;
}

export interface WorkStep {
  kind: 'step';
  id: string;
  icon: StepIcon;
  label: string;
  tool: string;
  status: 'success' | 'error' | 'pending';
  /** `+N -M` for file-changing tools, else null. */
  diffstat: { added: number; removed: number } | null;
  detail: StepDetail | null;
  images: string[];
  /** Images the caps left out, so the card can say so rather than lie. */
  imagesDropped?: number;
  /** Set on `subagent` spawns -- the client draws a nested agent card. */
  subagent?: SubagentSpawn;
  /** Set on file writes and edits -- the client draws a diff card. */
  file?: FileEdit;
}

/** Mid-turn commentary, drawn as a normal paragraph between steps. */
export interface WorkText {
  kind: 'text';
  id: string;
  text: string;
}

export type WorkItem = WorkStep | WorkText;

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  ts: number | null;
  /** Files the message carried, drawn as chips on the bubble. */
  attachments?: Array<{ name: string; mimeType?: string }>;
}

export interface WorkBlock {
  kind: 'work';
  id: string;
  items: WorkItem[];
  durationMs: number;
  /** Turn still in flight: the fold shows the latest label with a spinner. */
  running: boolean;
}

export interface AnswerItem {
  kind: 'answer';
  id: string;
  text: string;
  model?: string;
  provider?: string;
  ts: number | null;
}

/** Daemon-level failures (unavailable model, etc.) surfaced inline. */
export interface ErrorItem {
  kind: 'error';
  id: string;
  text: string;
}

export type ThreadItem = UserItem | WorkBlock | AnswerItem | ErrorItem;

const OUTPUT_LIMIT = 4000;

/**
 * Caps on the inline images a tool result contributes to a step.
 *
 * A screenshot arrives as base64 inside the transcript, and every one of
 * them used to be copied verbatim into the thread item -- uncapped and
 * uncounted, unlike every other field here. Measured on a real session
 * (2026-07-09, 57MB transcript): 58.1 MB of data URIs across 91 images in
 * 35 items. That payload was the whole `/api/sessions/:id/thread` response,
 * it was re-sent over the socket on every resync, and `firstDivergence`
 * re-serialised it on every 150ms push -- 176ms of blocking CPU per tick
 * against a 150ms throttle, i.e. an event loop that never catches up.
 *
 * A dropped image is reported as such, so the client shows a placeholder
 * rather than pretending the tool returned nothing. The bytes remain
 * reachable through the artifacts route, which is the path that has a size
 * limit and a download.
 */
export const MAX_STEP_IMAGES = 3;
export const MAX_IMAGE_BYTES = 256 * 1024;
/**
 * Budget for the whole thread, not just one step.
 *
 * Per-step caps alone still let a long session accumulate: the same real
 * transcript came back at 20MB with only the per-step limits in place,
 * because it holds dozens of steps that each returned a screenshot. A
 * thread-wide budget is what actually bounds the response, and the oldest
 * steps give theirs up first -- the newest work is what a reader is looking
 * at.
 */
export const MAX_THREAD_IMAGE_BYTES = 6 * 1024 * 1024;

const ICONS: Record<string, StepIcon> = {
  bash: 'terminal',
  repl: 'globe',
  openTab: 'globe',
  webfetch: 'globe',
  websearch: 'search',
  memory_search: 'search',
  read_file: 'file',
  write_file: 'file',
  edit_file: 'file',
  write_todos: 'list',
  subagent: 'agent',
  subagent_wait: 'agent',
  get_time: 'clock',
  notification: 'bell',
  request_action_confirmation: 'shield',
};

export function iconFor(tool: string): StepIcon {
  return ICONS[tool] || 'dot';
}

function basename(p: string): string {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || String(p || '');
}

/** Count +/- lines in a unified diff, ignoring its @@ hunk headers. */
export function diffstatOf(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/** How many diff lines travel with one file card. */
const FILE_LINE_LIMIT = 400;

/**
 * Unified-diff body as numbered lines.
 *
 * Numbering follows the `+` side of each `@@` header, so the card shows the
 * line numbers the file ends up with -- which is what the browser shows and
 * what someone reading a write actually wants.
 */
export function parseDiffLines(diff: string): FileEditLine[] {
  const out: FileEditLine[] = [];
  let n = 1;
  for (const raw of String(diff || '').split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) out.push({ n: n++, kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ n: null, kind: 'del', text: raw.slice(1) });
    else if (raw.startsWith(' ')) out.push({ n: n++, kind: 'ctx', text: raw.slice(1) });
  }
  return out;
}

/** Every line of a brand new file, as additions numbered from 1. */
function writtenLines(content: string): FileEditLine[] {
  return content
    .split('\n')
    .map((text, index) => ({ n: index + 1, kind: 'add' as const, text }));
}

/**
 * The diff card for a file-changing tool, or null for every other tool.
 *
 * An edit prefers the result's real unified diff and falls back to its
 * requested `edits` while the tool is still in flight, so the card is
 * populated from the moment the call is written rather than only once it
 * has finished.
 */
export function fileEditFrom(
  tool: string,
  args: unknown,
  details: Record<string, unknown> | undefined,
): FileEdit | null {
  const path = argOf(args, 'file_path') || argOf(args, 'path');
  if (!path) return null;

  let lines: FileEditLine[];
  if (tool === 'write_file') {
    lines = writtenLines(argOf(args, 'content'));
  } else if (tool === 'edit_file') {
    const diff = details && typeof details.diff === 'string' ? details.diff : '';
    lines = diff ? parseDiffLines(diff) : requestedEditLines(args);
  } else {
    return null;
  }

  return {
    mode: tool === 'write_file' ? 'write' : 'edit',
    path,
    name: basename(path),
    lines: lines.slice(0, FILE_LINE_LIMIT),
    truncated: lines.length > FILE_LINE_LIMIT,
  };
}

/** `edit_file`'s own `edits: [{oldText, newText}]`, as removals then adds. */
function requestedEditLines(args: unknown): FileEditLine[] {
  const edits = (args as { edits?: unknown } | null)?.edits;
  if (!Array.isArray(edits)) return [];
  const out: FileEditLine[] = [];
  let n = 1;
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') continue;
    const oldText = String((edit as any).oldText || '');
    const newText = String((edit as any).newText || '');
    if (oldText) {
      for (const text of oldText.split('\n')) {
        out.push({ n: null, kind: 'del', text });
      }
    }
    for (const text of newText.split('\n')) out.push({ n: n++, kind: 'add', text });
  }
  return out;
}

function argOf(args: unknown, key: string): string {
  if (!args || typeof args !== 'object') return '';
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/**
 * The human label for a step, matching what the sidepanel prints.
 *
 * `arguments.title` wins whenever the tool provides one -- that is the
 * agent's own description of the step and is what the browser shows.
 */
export function labelFor(
  tool: string,
  args: unknown,
  details: Record<string, unknown> | undefined,
): string {
  const title = argOf(args, 'title');
  if (title) return title;

  switch (tool) {
    case 'write_file':
      return `Wrote ${basename(argOf(args, 'file_path') || argOf(args, 'path'))}`;
    case 'edit_file':
      return `Edited ${basename(argOf(args, 'file_path') || argOf(args, 'path'))}`;
    case 'read_file': {
      const skill = details && typeof details.skillName === 'string'
        ? details.skillName
        : '';
      if (skill) return `Read the ${skill} skill`;
      return `Read ${basename(argOf(args, 'path') || argOf(args, 'file_path'))}`;
    }
    case 'memory_search':
      return 'Searched memory';
    case 'websearch': {
      // The tool's argument is `objective`, not `query` -- verified against
      // live transcripts, and it is what the desktop app quotes in the row.
      // Every search was reading "Searched the web" until subagent cards
      // made a column of them visible at once.
      const objective = argOf(args, 'objective') || argOf(args, 'query');
      return objective ? `Searched “${objective}”` : 'Searched the web';
    }
    case 'webfetch':
      return `Fetched ${argOf(args, 'url') || 'a page'}`;
    case 'write_todos':
      return 'Updated the task list';
    case 'get_time':
      return 'Checked the time';
    case 'subagent': {
      // The sidepanel prefixes a spawn with the verb and leaves the other
      // actions (status, cancel) reading as themselves.
      const description = argOf(args, 'description');
      const action = argOf(args, 'action');
      if (description && (!action || action === 'spawn')) {
        return `Spawned ${description}`;
      }
      return description || 'Dispatched a subagent';
    }
    case 'subagent_wait':
      return 'Waited for subagents';
    default:
      return tool;
  }
}

/**
 * A spawn descriptor for a `subagent` toolCall, or null for anything else.
 *
 * Only `action: "spawn"` creates a child; the same tool name also carries
 * status and cancel actions, which are ordinary steps.
 */
export function spawnFrom(
  tool: string,
  callId: string,
  args: unknown,
  hue = 0,
): SubagentSpawn | null {
  if (tool !== 'subagent' || !callId) return null;
  const action = argOf(args, 'action');
  if (action && action !== 'spawn') return null;
  const description = argOf(args, 'description');
  const prompt = argOf(args, 'prompt').split('\n')[0].trim();
  if (!description && !prompt) return null;
  return {
    callId,
    description: description || 'Subagent',
    prompt,
    hue: ((hue % SUBAGENT_PALETTE_SIZE) + SUBAGENT_PALETTE_SIZE) %
      SUBAGENT_PALETTE_SIZE,
  };
}

/** The monospace command line shown in an expanded tool card. */
function commandFor(tool: string, args: unknown): string {
  const direct =
    argOf(args, 'command') ||
    argOf(args, 'code') ||
    argOf(args, 'objective') ||
    argOf(args, 'query') ||
    argOf(args, 'url') ||
    argOf(args, 'path') ||
    argOf(args, 'file_path');
  if (direct) return direct;
  if (args && typeof args === 'object') {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

function textParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const p of content) {
    if (p && typeof p === 'object' && (p as any).type === 'text') {
      out.push(String((p as any).text || ''));
    }
  }
  return out.join('\n');
}

/**
 * Inline images for a step, capped in count and in size.
 *
 * `dropped` counts what did not fit, so the caller can say so instead of
 * silently showing fewer images than the tool produced. See
 * MAX_STEP_IMAGES / MAX_IMAGE_BYTES for why the caps exist at all.
 */
export function imageParts(content: unknown): {
  images: string[];
  dropped: number;
} {
  if (!Array.isArray(content)) return { images: [], dropped: 0 };
  const images: string[] = [];
  let dropped = 0;
  for (const p of content) {
    if (!p || typeof p !== 'object' || (p as any).type !== 'image') continue;
    const data = String((p as any).data || '');
    if (!data) continue;
    if (images.length >= MAX_STEP_IMAGES || data.length > MAX_IMAGE_BYTES) {
      dropped += 1;
      continue;
    }
    const mime = String((p as any).mimeType || 'image/png');
    images.push(`data:${mime};base64,${data}`);
  }
  return { images, dropped };
}

interface PendingCall {
  step: WorkStep;
  args: unknown;
}

/**
 * Assistant `content` as a list of parts.
 *
 * The CLI writes some assistant records with a bare string body rather than
 * a part array. Treating those as "no parts" (which a plain
 * `Array.isArray` check does) silently drops whole answers from sessions
 * written that way, so a string is promoted to a single text part.
 */
function assistantParts(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

/**
 * Build the thread. `running` marks the session as mid-turn, which makes
 * the trailing fold show a live spinner instead of a final duration.
 *
 * The message list may begin mid-conversation -- a compacted session's tail
 * has no leading user message -- so work accumulated before the first user
 * bubble is flushed as its own fold rather than discarded.
 */
export function buildThread(
  messages: Array<FacadeMessage | HistoryMessage>,
  running = false,
): ThreadItem[] {
  const items: ThreadItem[] = [];

  // Everything accumulated for the current turn before we know which
  // assistant text is the final answer.
  let work: WorkItem[] = [];
  let turnStart: number | null = null;
  let turnEnd: number | null = null;
  const byCallId = new Map<string, PendingCall>();
  /**
   * Next palette slot. Counts across the WHOLE session rather than per
   * turn, so a subagent spawned in turn 4 cannot land on the colour a
   * still-visible sibling from turn 1 already has.
   */
  let nextHue = 0;

  const flushTurn = (isLast: boolean) => {
    if (!work.length) return;

    // The last assistant paragraph of the turn is the answer; the fold
    // keeps everything before it.
    // Only the LAST item can be the answer: text mid-way through the work is
    // commentary, and a turn that ends on a tool call has not answered yet.
    //
    // This used to be a reverse loop with an `every(w => w.kind === 'text')`
    // guard inside it, which read as if it examined the tail. It could not:
    // both branches broke on the first iteration, so the loop only ever saw
    // `work[work.length - 1]` and the guard's slice was always empty and
    // always true. Mutating it to `if (true)` changed no behaviour and broke
    // no test -- which is what a vacuous condition looks like from the
    // outside. Written as what it actually does.
    let answer: WorkText | null = null;
    const last = work[work.length - 1];
    if (last?.kind === 'text') {
      answer = last;
      work = work.slice(0, -1);
    }

    // A block whose turn already produced its answer is finished, even when
    // the session is busy again: that is the window between `turn_started`
    // and the new user message reaching the transcript, and marking the
    // PREVIOUS turn's fold as running made it flash back open on every send.
    const stillRunning = running && isLast && !answer;
    if (work.length) {
      items.push({
        kind: 'work',
        id: `work-${items.length}`,
        items: work,
        durationMs:
          turnStart !== null && turnEnd !== null && turnEnd > turnStart
            ? turnEnd - turnStart
            : 0,
        running: stillRunning,
      });
    }
    if (answer) {
      items.push({
        kind: 'answer',
        id: `answer-${items.length}`,
        text: answer.text,
        ts: turnEnd,
      });
    }
    work = [];
    turnStart = null;
    turnEnd = null;
    byCallId.clear();
  };

  messages.forEach((msg, index) => {
    const ts = typeof msg.timestamp === 'number' ? msg.timestamp : null;

    if (msg.role === 'user') {
      flushTurn(false);
      // Files this app sent are named in a header inside the prompt, which
      // belongs to the agent, not to the reader -- so it comes back off and
      // becomes chips. Files attached in the browser arrive as structured
      // metadata instead; both end up in the same place.
      const split = splitAttachmentHeader(textParts(msg.content));
      const text = split.text.trim();
      const attachments = (msg as HistoryMessage).attachments?.length
        ? (msg as HistoryMessage).attachments
        : split.files.length
          ? split.files
          : undefined;
      // A message can be attachments-only, so an empty body is still a
      // bubble when files came with it.
      if (text || attachments?.length) {
        const item: UserItem = { kind: 'user', id: `user-${index}`, text, ts };
        if (attachments?.length) item.attachments = attachments;
        items.push(item);
      }
      return;
    }

    if (msg.role === 'assistant') {
      if (ts !== null) {
        if (turnStart === null) turnStart = ts;
        turnEnd = ts;
      }
      const content = assistantParts(msg.content);
      for (const rawPart of content) {
        const part = rawPart as Record<string, unknown>;
        if (part.type === 'text') {
          const text = String(part.text || '').trim();
          if (text) work.push({ kind: 'text', id: `t-${index}-${work.length}`, text });
        } else if (part.type === 'toolCall') {
          const tool = String(part.name || 'tool');
          const step: WorkStep = {
            kind: 'step',
            id: `s-${index}-${work.length}`,
            icon: iconFor(tool),
            label: labelFor(tool, part.arguments, undefined),
            tool,
            status: 'pending',
            diffstat: null,
            detail: { command: commandFor(tool, part.arguments) },
            images: [],
          };
          const callId = typeof part.id === 'string' ? part.id : '';
          const spawn = spawnFrom(tool, callId, part.arguments, nextHue);
          if (spawn) {
            step.subagent = spawn;
            nextHue += 1;
          }
          const file = fileEditFrom(tool, part.arguments, undefined);
          if (file) step.file = file;
          work.push(step);
          if (callId) byCallId.set(callId, { step, args: part.arguments });
        }
        // `thinking` parts are intentionally dropped.
      }
      return;
    }

    if (msg.role === 'toolResult') {
      if (ts !== null) turnEnd = ts;
      const callId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
      const pending = callId ? byCallId.get(callId) : undefined;
      if (!pending) return;

      const { step, args } = pending;
      const details = (msg.details || {}) as Record<string, unknown>;
      step.status = msg.isError ? 'error' : 'success';

      // Now that details are in hand the label can improve (a skill read
      // names the skill; a file edit gets its diffstat).
      step.label = labelFor(step.tool, args, details);

      if (typeof details.diff === 'string') {
        step.diffstat = diffstatOf(details.diff);
      } else if (step.tool === 'write_file') {
        const content = argOf(args, 'content');
        if (content) {
          step.diffstat = { added: content.split('\n').length, removed: 0 };
        }
      }

      // The result carries the real unified diff, which beats the edits the
      // call asked for.
      const file = fileEditFrom(step.tool, args, details);
      if (file) step.file = file;

      const output = textParts(msg.content);
      step.detail = {
        command: step.detail?.command || '',
        output: output.slice(0, OUTPUT_LIMIT),
        truncated: output.length > OUTPUT_LIMIT,
      };
      const shown = imageParts(msg.content);
      step.images = shown.images;
      if (shown.dropped) step.imagesDropped = shown.dropped;
    }
  });

  flushTurn(true);
  applyImageBudget(items);
  return items;
}

/**
 * Enforce MAX_THREAD_IMAGE_BYTES across the finished thread.
 *
 * Walked newest-first so the steps a reader is actually looking at keep
 * their screenshots and older ones are reduced to an honest count.
 */
export function applyImageBudget(
  items: ThreadItem[],
  budget = MAX_THREAD_IMAGE_BYTES,
): void {
  let left = budget;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'work') continue;
    for (let j = item.items.length - 1; j >= 0; j -= 1) {
      const step = item.items[j];
      if (step.kind !== 'step' || !step.images.length) continue;
      const kept: string[] = [];
      let dropped = step.imagesDropped ?? 0;
      for (const image of step.images) {
        if (image.length <= left) {
          left -= image.length;
          kept.push(image);
        } else {
          dropped += 1;
        }
      }
      step.images = kept;
      if (dropped) step.imagesDropped = dropped;
      else delete step.imagesDropped;
    }
  }
}

/** Every tool step of a thread, in order, ignoring the fold boundaries. */
export function workSteps(items: ThreadItem[]): WorkStep[] {
  const out: WorkStep[] = [];
  for (const item of items) {
    if (item.kind !== 'work') continue;
    for (const step of item.items) if (step.kind === 'step') out.push(step);
  }
  return out;
}

/**
 * Join spawn steps to the child sessions they created, in place, and hand
 * back the same children carrying the palette slot of the spawn row that
 * created them.
 *
 * Keyed on the spawn's own toolCall id, which the daemon records as the
 * child's `trigger.toolCallId` -- so this is an exact match rather than a
 * guess from titles or ordering.
 *
 * The return value is what the session panel lists: the panel draws the
 * same creature as the spawn row, so it has to be told the same slot
 * rather than deriving one of its own. A child whose spawn is not in this
 * transcript (a stale row, or a spawn the parent has since compacted away)
 * keeps a slot after the ones that are, so it still gets a colour and
 * still cannot collide with a live sibling.
 */
export function attachChildren(
  items: ThreadItem[],
  children: ChildSession[],
): ChildSession[] {
  if (!children.length) return children;
  const byCallId = new Map(children.map((child) => [child.toolCallId, child]));
  const hueByCallId = new Map<string, number>();
  let maxHue = -1;
  for (const item of items) {
    if (item.kind !== 'work') continue;
    for (const step of item.items) {
      if (step.kind !== 'step' || !step.subagent) continue;
      const child = byCallId.get(step.subagent.callId);
      if (child) step.subagent.child = child;
      hueByCallId.set(step.subagent.callId, step.subagent.hue);
      maxHue = Math.max(maxHue, step.subagent.hue);
    }
  }
  let spare = maxHue + 1;
  return children.map((child) => {
    const hue = hueByCallId.get(child.toolCallId);
    return {
      ...child,
      hue: (hue ?? spare++) % SUBAGENT_PALETTE_SIZE,
    };
  });
}

/** What the context ring and the streaming footer read. */
export interface ThreadStats {
  /** Last assistant `usage.totalTokens` -- how full the context window is. */
  totalTokens: number;
  /** Output (plus reasoning) tokens produced since the last user message. */
  turnTokens: number;
  /** When the current turn's first assistant message landed, or null. */
  turnStartedAt: number | null;
}

function usageNumber(usage: unknown, key: string): number {
  if (!usage || typeof usage !== 'object') return 0;
  const value = Number((usage as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Token accounting for the live session bar.
 *
 * `totalTokens` is cumulative context occupancy as the model last reported
 * it, so it is simply the newest value seen. `turnTokens` resets at each
 * user message, which is what makes the footer's `↓ 506 tokens` mean "this
 * turn" rather than "this session".
 */
export function threadStats(
  messages: Array<FacadeMessage | HistoryMessage>,
): ThreadStats {
  let totalTokens = 0;
  let turnTokens = 0;
  let turnStartedAt: number | null = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      turnTokens = 0;
      turnStartedAt = null;
      continue;
    }
    if (msg.role !== 'assistant') continue;
    const usage = (msg as HistoryMessage).usage;
    const total = usageNumber(usage, 'totalTokens');
    if (total) totalTokens = total;
    turnTokens += usageNumber(usage, 'output') + usageNumber(usage, 'reasoning');
    if (turnStartedAt === null && typeof msg.timestamp === 'number') {
      turnStartedAt = msg.timestamp;
    }
  }

  return { totalTokens, turnTokens, turnStartedAt };
}
