/**
 * Full session history, read from messages.jsonl on disk.
 *
 * Why not the facade: `aside.sessions.messages(id)` returns the agent's
 * CURRENT CONTEXT, not the conversation. On a long or compacted session it
 * starts mid-conversation -- verified on a long live session, where the
 * facade hands back 50 messages beginning with a `system-message` while the
 * transcript on disk holds 300 lines and four separate user turns. Built
 * from the facade, that session collapses into one bare work fold with no
 * user bubble and no answers.
 *
 * The jsonl carries the same record shape the facade emits (`role`,
 * `content`, `timestamp`, `toolCallId`, `toolName`, `details`, `isError`),
 * so the thread builder consumes either. The differences this module
 * normalises away:
 *
 *  - Timestamps are seconds on disk and ms in places; both are coerced to ms.
 *  - `content` is a bare STRING on user messages written by the CLI, and a
 *    part array on assistant messages.
 *  - `user-message-metadata` is a separate record that PRECEDES the user
 *    message it belongs to and carries that message's attachments. It is
 *    folded onto the following user message rather than surfaced as a row.
 *  - `system-message` is skipped, exactly as the browser skips it.
 */
import fs from 'node:fs';
import type { FacadeMessage } from './facade.js';

/** A file the user attached to a message, as the transcript records it. */
export interface MessageAttachment {
  name: string;
  mimeType?: string;
}

export interface HistoryMessage extends FacadeMessage {
  /** Present on user messages that carried attachments. */
  attachments?: MessageAttachment[];
  /** Assistant token accounting: `totalTokens`, `output`, `reasoning`, … */
  usage?: Record<string, unknown>;
}

/** Aside writes timestamps in seconds on some records and ms on others. */
export function normalizeTimestamp(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : Math.round(n * 1000);
}

function readAttachments(raw: unknown): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as any).name || '').trim();
    if (!name) continue;
    out.push({
      name,
      mimeType: (item as any).mimeType
        ? String((item as any).mimeType)
        : undefined,
    });
  }
  return out;
}

/**
 * Parse a whole transcript buffer into the message list the thread builder
 * consumes. Corrupt lines are skipped, as they are everywhere else here.
 */
export function parseHistory(buffer: string): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  // Attachments arrive on their own record just BEFORE the user message
  // they describe, so they are held until that message shows up.
  let pendingAttachments: MessageAttachment[] = [];

  for (const raw of String(buffer || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const role = String(msg.role || '');
    if (!role) continue;

    if (role === 'user-message-metadata') {
      const found = readAttachments(msg.attachments);
      if (found.length) pendingAttachments = found;
      continue;
    }

    // The browser hides system messages; so do we. They are injected
    // context (skill hints, and similar), not conversation.
    if (role === 'system-message') continue;

    const entry: HistoryMessage = {
      role,
      content: msg.content,
      timestamp: normalizeTimestamp(msg.timestamp),
    };
    if (typeof msg.model === 'string') entry.model = msg.model;
    if (typeof msg.provider === 'string') entry.provider = msg.provider;
    if (typeof msg.toolCallId === 'string') entry.toolCallId = msg.toolCallId;
    if (typeof msg.toolName === 'string') entry.toolName = msg.toolName;
    if (msg.details && typeof msg.details === 'object') {
      entry.details = msg.details as Record<string, unknown>;
    }
    if (msg.usage && typeof msg.usage === 'object') {
      entry.usage = msg.usage as Record<string, unknown>;
    }
    if (msg.isError) entry.isError = true;

    if (role === 'user' && pendingAttachments.length) {
      entry.attachments = pendingAttachments;
      pendingAttachments = [];
    }

    out.push(entry);
  }

  return out;
}

/** Read and parse a session transcript. Missing/unreadable reads as empty. */
export function readHistory(msgFile: string): HistoryMessage[] {
  let buffer = '';
  try {
    buffer = fs.readFileSync(msgFile, 'utf8');
  } catch {
    return [];
  }
  return parseHistory(buffer);
}
