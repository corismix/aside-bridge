/**
 * messages.jsonl parsing.
 *
 * Ported from bridge.py's `stream_new` / `TurnStream`, which is the
 * production-tested reading of Aside's transcript format. The rules that
 * matter and that are easy to get wrong:
 *
 *  - The transcript is the source of truth for replies, not CLI stdout.
 *  - A line is only safe to parse once it ends in "\n"; the last line of a
 *    live file is routinely a partial write.
 *  - A tool call's human label is `arguments.title`, falling back to the
 *    raw tool name.
 *  - Subagents are spawned under a toolCallId but later referenced only by
 *    task_id, which first appears in the spawn toolResult's
 *    `details.taskId`. Without re-keying, every `subagent_wait` result
 *    would look like an unknown agent.
 *  - `subagent_wait` results arrive as one blob containing one
 *    <subagent_result task_id="..."> block per finished subagent.
 */

export type TranscriptEntryKind =
  | 'user'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'subagent';

interface BaseEntry {
  /** 0-based physical line offset in messages.jsonl -- the stable cursor. */
  line: number;
  /** Index of the content part within that line. */
  part: number;
  /** `${line}:${part}` -- stable across refetches, safe as a React key. */
  id: string;
  ts: number | null;
}

export interface UserEntry extends BaseEntry {
  kind: 'user';
  text: string;
}
export interface AssistantTextEntry extends BaseEntry {
  kind: 'assistant_text';
  text: string;
  model?: string;
}
export interface ThinkingEntry extends BaseEntry {
  kind: 'thinking';
  text: string;
}
export interface ToolCallEntry extends BaseEntry {
  kind: 'tool_call';
  toolCallId?: string;
  name: string;
  title: string;
}
export interface ToolResultEntry extends BaseEntry {
  kind: 'tool_result';
  toolCallId?: string;
  name: string;
  isError: boolean;
  preview: string;
}
export interface SubagentEntry extends BaseEntry {
  kind: 'subagent';
  event: 'spawn' | 'wait' | 'result';
  taskId?: string;
  callId?: string;
  desc: string;
  profile?: string;
  background?: boolean;
  text?: string;
  isError?: boolean;
}

export type TranscriptEntry =
  | UserEntry
  | AssistantTextEntry
  | ThinkingEntry
  | ToolCallEntry
  | ToolResultEntry
  | SubagentEntry;

const SUBAGENT_RESULT_RE =
  /<subagent_result task_id="([^"]+)">([\s\S]*?)<\/subagent_result>/g;

interface SubagentInfo {
  desc: string;
  profile: string;
  background: boolean;
  callId?: string;
  taskId?: string;
}

/** Aside writes timestamps in seconds on some records and ms on others. */
function normalizeTs(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : Math.round(n * 1000);
}

export function collapseWhitespace(text: string): string {
  return (text || '').split(/\s+/).filter(Boolean).join(' ');
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Flatten markdown to prose for the session-card preview.
 *
 * The preview is a plain one-line snippet, so leaving the source syntax in
 * shows the reader `**Opener**` and stray backticks where the sidepanel
 * shows formatted text. This strips the markers rather than rendering
 * them.
 */
export function stripMarkdown(text: string): string {
  return (text || '')
    // Citation markup is machine addressing, never prose. The reader of a
    // one-line preview should see the supporting sentence, not the tag
    // around it.
    .replace(/<\/?citation(?:\s+refs="[^"]*")?\s*>/g, '')
    .replace(/<\/?quote>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/(\*\*\*|___)(.*?)\1/g, '$2')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(?<![\w*])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?![\w*])/g, '$1')
    .replace(/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/gm, ' ');
}

/** Text out of a `content` field that may be a bare string or a part list. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as any).type === 'text') {
      chunks.push(String((part as any).text || ''));
    }
  }
  return chunks.join('\n');
}

/**
 * Stateful line-by-line transcript parser. State is only the subagent
 * registry, which exists so task_id-only events can recover the
 * description recorded at spawn time.
 */
export class TranscriptParser {
  private subagents = new Map<string, SubagentInfo>();

  feedLine(raw: string, line: number): TranscriptEntry[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return []; // a corrupt line is skipped, exactly as bridge.py does
    }

    const ts = normalizeTs(msg.timestamp);
    const role = msg.role;
    const out: TranscriptEntry[] = [];
    const base = (part: number) => ({ line, part, id: `${line}:${part}`, ts });

    if (role === 'user') {
      const text = textOf(msg.content).trim();
      if (text) out.push({ ...base(0), kind: 'user', text });
      return out;
    }

    if (role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const model = typeof msg.model === 'string' ? msg.model : undefined;
      content.forEach((part: any, index: number) => {
        if (!part || typeof part !== 'object') return;
        if (part.type === 'text' && String(part.text || '').trim()) {
          out.push({
            ...base(index),
            kind: 'assistant_text',
            text: String(part.text),
            model,
          });
          return;
        }
        if (part.type === 'thinking' && String(part.thinking || '').trim()) {
          out.push({
            ...base(index),
            kind: 'thinking',
            text: String(part.thinking),
          });
          return;
        }
        if (part.type !== 'toolCall') return;

        const name = String(part.name || '');
        const args = (part.arguments || {}) as Record<string, unknown>;
        const callId = part.id ? String(part.id) : undefined;

        if (name === 'subagent' && args.action === 'spawn') {
          const desc =
            collapseWhitespace(
              String(args.description || args.prompt || '') || 'subagent',
            ) || 'subagent';
          const info: SubagentInfo = {
            desc,
            profile: String(args.subagent_profile || 'default'),
            background: Boolean(args.run_in_background),
            callId,
          };
          if (callId) this.subagents.set(callId, info);
          out.push({
            ...base(index),
            kind: 'subagent',
            event: 'spawn',
            callId,
            desc,
            profile: info.profile,
            background: info.background,
          });
          return;
        }

        if (name === 'subagent_wait') {
          const taskIds = Array.isArray(args.task_ids)
            ? (args.task_ids as unknown[]).map(String)
            : [];
          if (!taskIds.length) return;
          for (const taskId of taskIds) {
            out.push({
              ...base(index),
              id: `${line}:${index}:${taskId}`,
              kind: 'subagent',
              event: 'wait',
              taskId,
              desc: this.subagents.get(taskId)?.desc || taskId,
            });
          }
          return;
        }

        out.push({
          ...base(index),
          kind: 'tool_call',
          toolCallId: callId,
          name,
          title: collapseWhitespace(String(args.title || '') || name) || name,
        });
      });
      return out;
    }

    if (role === 'toolResult') {
      const toolName = String(msg.toolName || '');
      const toolCallId = msg.toolCallId ? String(msg.toolCallId) : undefined;
      const isError = Boolean(msg.isError);
      const text = textOf(msg.content);

      if (toolName === 'subagent') {
        // Re-key the spawn registry from toolCallId to the real task_id.
        const taskId = String(
          ((msg.details as Record<string, unknown>) || {}).taskId || '',
        );
        if (taskId && toolCallId) {
          const info = this.subagents.get(toolCallId);
          if (info) {
            info.taskId = taskId;
            this.subagents.set(taskId, info);
          }
        }
        return out;
      }

      if (toolName === 'subagent_wait') {
        SUBAGENT_RESULT_RE.lastIndex = 0;
        const matches = [...text.matchAll(SUBAGENT_RESULT_RE)];
        if (matches.length) {
          matches.forEach((match, index) => {
            const taskId = match[1];
            out.push({
              ...base(index),
              id: `${line}:${index}:${taskId}`,
              kind: 'subagent',
              event: 'result',
              taskId,
              desc: this.subagents.get(taskId)?.desc || taskId,
              text: match[2].trim(),
              isError,
            });
          });
        } else if (text.trim()) {
          const taskId = toolCallId || 'subagent';
          out.push({
            ...base(0),
            kind: 'subagent',
            event: 'result',
            taskId,
            desc: this.subagents.get(taskId)?.desc || taskId,
            text: text.trim(),
            isError,
          });
        }
        return out;
      }

      out.push({
        ...base(0),
        kind: 'tool_result',
        toolCallId,
        name: toolName,
        isError,
        preview: truncate(collapseWhitespace(text), 400),
      });
      return out;
    }

    // system-message / user-message-metadata and anything future: ignored.
    return out;
  }
}

/**
 * Split a transcript buffer into lines that are safe to parse.
 *
 * A live messages.jsonl usually ends mid-write, so the final unterminated
 * line is dropped -- unless it happens to be complete JSON already, which
 * covers the (rare) file saved without a trailing newline.
 */
export function completeLines(buffer: string): string[] {
  const lines = buffer.split('\n');
  const tail = lines.pop();
  if (tail === undefined || tail === '') return lines;
  try {
    JSON.parse(tail);
    lines.push(tail);
  } catch {
    // partial write still in flight -- it will show up on the next read
  }
  return lines;
}

/**
 * Parse a whole transcript buffer. Entries at or before `afterLine` are
 * still replayed (cheaply) so subagent descriptions resolve, then filtered
 * out of the result.
 */
export function parseTranscript(
  buffer: string,
  opts: { afterLine?: number } = {},
): { entries: TranscriptEntry[]; lastLine: number } {
  const afterLine = opts.afterLine ?? -1;
  const parser = new TranscriptParser();
  const lines = completeLines(buffer);

  const entries: TranscriptEntry[] = [];
  lines.forEach((raw, line) => {
    const produced = parser.feedLine(raw, line);
    if (line > afterLine) entries.push(...produced);
  });
  return { entries, lastLine: lines.length - 1 };
}
