/**
 * Session discovery over ~/.aside/u/0/sessions.
 *
 * Directories are named `<date>_<sessionId>`; the CLI takes the trailing
 * short id, so that is the id this API speaks. Resolution is done by
 * scanning for a directory ending in `_<id>` (bridge.py's rule), which is
 * also why no caller-supplied string can ever escape the sessions root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { collapseWhitespace, stripMarkdown, truncate } from './transcript.js';
import { fetchSessions, type FacadeCache, type FacadeSession } from './facade.js';
import type { StateSessionRow } from './statedb.js';
import { splitAttachmentHeader } from './uploads.js';
import { isMobileSeededText, stripAgentDirectives } from './preamble.js';

export interface SessionSummary {
  id: string;
  date: string;
  /** Directory mtime in ms -- last activity. */
  mtime: number;
  title: string;
  preview: string;
  turns: number;
  lastTotalTokens: number;
  totalCost: number;
}

/**
 * A session row as the UI draws it.
 *
 * Deliberately absent: ids, costs, token counts, turn counts. The Aside
 * sidepanel shows none of those and neither does this.
 */
export interface SessionRow {
  /** Needed for routing, never rendered. */
  id: string;
  title: string;
  preview: string;
  status: 'running' | 'idle' | 'errored' | string;
  /** Last activity, ms since epoch -- drives "13 hours ago". */
  updatedAt: number;
  createdAt: number;
  /** readAt < updatedAt means the browser would show an unread dot. */
  unread: boolean;
  trigger?: string;
}

/** Session ids are opaque CLI tokens; anything else is not a session id. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function resolveSessionDir(
  sessionsDir: string,
  sessionId: string,
): string | null {
  if (!isValidSessionId(sessionId)) return null;
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}`;
  for (const name of names) {
    if (name.endsWith(suffix)) {
      const full = path.join(sessionsDir, name);
      if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
        return full;
      }
    }
  }
  return null;
}

export function sessionMsgFile(
  sessionsDir: string,
  sessionId: string,
): string | null {
  const dir = resolveSessionDir(sessionsDir, sessionId);
  return dir ? path.join(dir, 'messages.jsonl') : null;
}

/**
 * The persona seed bridge.py writes into every /new session looks
 * identical everywhere, so it never makes a useful title.
 */
const PERSONA_SEED_MARK = 'permanent telegram thread';

/** How much of a transcript is read looking for its first user message. */
const FIRST_MESSAGE_SCAN_BYTES = 64 * 1024;

/**
 * The first user message in a transcript, or "" when there is none.
 *
 * Reads a bounded prefix rather than the whole file: the first user row is
 * the first or second line of every transcript, and the owner's largest are
 * tens of megabytes.
 */
export function firstUserText(msgFile: string): string {
  let buffer = '';
  try {
    const fd = fs.openSync(msgFile, 'r');
    try {
      const chunk = Buffer.alloc(FIRST_MESSAGE_SCAN_BYTES);
      const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
      buffer = chunk.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  for (const raw of buffer.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // A truncated final line is expected -- the read is bounded.
      continue;
    }
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return String(
        msg.content.find((p: any) => p?.type === 'text')?.text ?? '',
      );
    }
  }
  return '';
}

/**
 * Whether this session was started from a phone -- by this app or by
 * bridge.py.
 *
 * The discriminator is the seed text both surfaces write into the first
 * prompt, so it needs no store, survives a cleared state directory, and
 * cannot drift out of sync with the transcript it describes. See
 * `isMobileSeededText`.
 */
export function isMobileSession(
  sessionsDir: string,
  sessionId: string,
): boolean {
  const msgFile = sessionMsgFile(sessionsDir, sessionId);
  return msgFile ? isMobileSeededText(firstUserText(msgFile)) : false;
}

function titleFrom(text: string): string {
  // The attachment header is addressed to the agent, not the reader; a
  // title of "[user sent 2 files from their phone, saved to: /Users/…]" is
  // no title at all. Seen on a live run.
  //
  // Same for the mobile preamble and the follow-up reminder. The preamble
  // is prepended BEFORE the attachment header, so `splitAttachmentHeader`
  // alone never saw the header at all and every Mini App session titled
  // itself "[Aside Mini App session. You are running for a user on…".
  let snippet = splitAttachmentHeader(stripAgentDirectives(text)).text;
  const noteAt = snippet.toLowerCase().indexOf('[bridge note');
  if (noteAt > 0) snippet = snippet.slice(0, noteAt);
  return truncate(collapseWhitespace(snippet), 64);
}

interface ScanResult {
  title: string;
  preview: string;
  turns: number;
  lastTotalTokens: number;
  totalCost: number;
}

/** One pass over a transcript for everything the session list shows. */
export function scanTranscript(buffer: string): ScanResult {
  let title = '';
  let fallbackTitle = '';
  let preview = '';
  let turns = 0;
  let lastTotalTokens = 0;
  let totalCost = 0;

  for (const raw of buffer.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.role === 'user') {
      turns += 1;
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content.find((p: any) => p?.type === 'text')?.text ?? '')
            : '';
      if (!text) continue;
      if (text.toLowerCase().includes(PERSONA_SEED_MARK)) {
        fallbackTitle = fallbackTitle || titleFrom(text);
        continue;
      }
      if (!title) title = titleFrom(text);
    } else if (msg.role === 'assistant') {
      const usage = msg.usage || {};
      if (usage.totalTokens) lastTotalTokens = Number(usage.totalTokens);
      totalCost += Number(usage?.cost?.total || 0);
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === 'text' && String(part.text || '').trim()) {
            preview = truncate(
              collapseWhitespace(stripMarkdown(String(part.text))),
              240,
            );
          }
        }
      }
    }
  }

  return {
    title: title || fallbackTitle || '(no messages)',
    preview,
    turns,
    lastTotalTokens,
    totalCost,
  };
}

interface CacheEntry extends ScanResult {
  size: number;
  mtimeMs: number;
}

/**
 * Bounded: the list is drawn from at most `limit` transcripts at a time, but
 * the key is a file path and the owner's directory holds 2250 of them, so an
 * unbounded map here grows with every session ever listed and never shrinks.
 * A couple of list-fulls is all the reuse this cache can actually get.
 */
const MAX_SCAN_CACHE = 300;
const scanCache = new Map<string, CacheEntry>();

function scanCached(msgFile: string, stat: fs.Stats): ScanResult {
  const hit = scanCache.get(msgFile);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    scanCache.delete(msgFile);
    scanCache.set(msgFile, hit);
    return hit;
  }
  let buffer = '';
  try {
    buffer = fs.readFileSync(msgFile, 'utf8');
  } catch {
    // unreadable transcript: fall through to an empty scan
  }
  const scanned = scanTranscript(buffer);
  scanCache.delete(msgFile);
  scanCache.set(msgFile, {
    ...scanned,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
  while (scanCache.size > MAX_SCAN_CACHE) {
    const oldest = scanCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
  return scanned;
}

/**
 * Newest sessions first. Only the `limit` most recent transcripts are read;
 * everything else is decided from directory metadata.
 */
export function listSessions(
  sessionsDir: string,
  limit = 30,
): SessionSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const rows: Array<{
    id: string;
    date: string;
    mtime: number;
    msgFile: string;
    stat: fs.Stats;
  }> = [];

  for (const name of names) {
    if (!name.includes('_')) continue;
    const dir = path.join(sessionsDir, name);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const msgFile = path.join(dir, 'messages.jsonl');
    const stat = fs.statSync(msgFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const cut = name.lastIndexOf('_');
    rows.push({
      id: name.slice(cut + 1),
      date: name.slice(0, cut),
      // The transcript's own mtime tracks activity more tightly than the
      // directory's, which also moves for artifacts and tmp files.
      mtime: Math.max(stat.mtimeMs, fs.statSync(dir).mtimeMs),
      msgFile,
      stat,
    });
  }

  rows.sort((a, b) => b.mtime - a.mtime);

  return rows.slice(0, Math.max(0, limit)).map((row) => ({
    id: row.id,
    date: row.date,
    mtime: row.mtime,
    ...scanCached(row.msgFile, row.stat),
  }));
}

/**
 * Title and preview for one session, read from its transcript.
 *
 * The preview is just the last assistant paragraph, identical on disk, so
 * reading it locally keeps the list cheap. The title matters more now: the
 * daemon stores a placeholder for CLI-created sessions (see
 * PLACEHOLDER_TITLES) and those are exactly the sessions this app itself
 * creates, so without a local derivation the list would be a column of
 * rows all reading "Aside CLI".
 */
function localScan(
  sessionsDir: string,
  id: string,
): { title: string; preview: string } {
  const dir = resolveSessionDir(sessionsDir, id);
  if (!dir) return { title: '', preview: '' };
  const msgFile = path.join(dir, 'messages.jsonl');
  const stat = fs.statSync(msgFile, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { title: '', preview: '' };
  const scanned = scanCached(msgFile, stat);
  return { title: scanned.title, preview: scanned.preview };
}

/**
 * Titles the daemon writes when it has none of its own. They are not
 * useful labels, so a transcript-derived title wins over them.
 */
const PLACEHOLDER_TITLES = new Set(['', 'aside cli', 'new session', 'untitled']);

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(String(title || '').trim().toLowerCase());
}

/**
 * A title derived from a session's own transcript.
 *
 * `localScan` already did this for the list, but privately. The thread
 * route needs the same answer for the same reason -- a session the daemon
 * has called "Aside CLI" should read the same in the header as it does in
 * the row above it -- so the derivation is exported rather than
 * reimplemented. Returns '' when there is nothing to derive from, which
 * the caller treats as "keep whatever the daemon said".
 */
export function titleFromTranscript(
  sessionsDir: string,
  id: string,
): string {
  return localScan(sessionsDir, id).title;
}

function timeOf(iso: string | undefined): number {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : 0;
}

function triggerType(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session list the UI renders.
 *
 * state.db is the primary source. The facade's `sessions.list()` returns
 * only what the browser sidepanel shows and drops every CLI-created
 * session -- 93 rows out of 179 on the owner's machine -- which is why
 * sessions started from the Telegram bridge, and from this app itself,
 * never appeared. See `StateDb.list` for the filter and its reasoning.
 *
 * Both remaining sources stay as fallbacks: the facade when the database
 * cannot be read (an older Node without node:sqlite, mainly), and a plain
 * directory scan when the facade is unreachable too. The app degrades to
 * the previous behaviour rather than to an empty screen.
 */
export async function listSessionRows(
  cache: FacadeCache,
  sessionsDir: string,
  limit = 100,
  stateDb?: { list: (limit?: number) => Promise<StateSessionRow[] | null> },
): Promise<{ rows: SessionRow[]; source: 'statedb' | 'facade' | 'filesystem' }> {
  const dbRows = stateDb ? await stateDb.list(limit).catch(() => null) : null;

  if (dbRows && dbRows.length) {
    const rows = dbRows.slice(0, limit).map((s) => {
      const local = localScan(sessionsDir, s.id);
      const title = isPlaceholderTitle(s.title) ? local.title : s.title;
      return {
        id: s.id,
        title: title || s.title || 'Untitled',
        preview: local.preview,
        status: s.status || 'idle',
        updatedAt: s.updatedAt || s.createdAt,
        createdAt: s.createdAt,
        unread: s.readAt < s.updatedAt,
        trigger: triggerType(s.trigger),
      };
    });
    return { rows, source: 'statedb' };
  }

  let facadeRows: FacadeSession[] = [];
  try {
    facadeRows = await fetchSessions(cache, limit);
  } catch {
    facadeRows = [];
  }

  if (facadeRows.length) {
    const rows = facadeRows
      .filter((s) => s && typeof s.id === 'string' && !s.incognito)
      .map((s) => {
        const updatedAt = timeOf(s.updatedAt) || timeOf(s.createdAt);
        const local = localScan(sessionsDir, s.id);
        const title = isPlaceholderTitle(s.title || '')
          ? local.title
          : (s.title || '').trim();
        return {
          id: s.id,
          title: title || 'Untitled',
          preview: local.preview,
          status: s.status || 'idle',
          updatedAt,
          createdAt: timeOf(s.createdAt),
          unread: timeOf(s.readAt) < updatedAt,
          trigger: s.trigger?.type,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { rows, source: 'facade' };
  }

  const rows = listSessions(sessionsDir, limit).map((s) => ({
    id: s.id,
    title: s.title,
    preview: s.preview,
    status: 'idle',
    updatedAt: s.mtime,
    createdAt: s.mtime,
    unread: false,
  }));
  return { rows, source: 'filesystem' };
}

/**
 * How long a just-created session may take to put a transcript on disk,
 * and how often to look. Shared with the WebSocket subscribe path so both
 * transports agree on what "not there yet" means.
 */
export const NEW_SESSION_WAIT_MS = 30_000;
export const NEW_SESSION_POLL_MS = 250;

/**
 * Resolve a session's transcript, waiting if it is still being created.
 *
 * `aside exec` hands back a session id as soon as its DIRECTORY appears;
 * messages.jsonl lands a moment later. The WebSocket already treated that
 * gap as a wait, but the REST `/thread` route answered 404 the instant the
 * file was missing -- so opening a brand new chat flashed
 * "404: session_not_found" for the fraction of a second before the file
 * appeared. Observed live: `POST /api/sessions/new` 200, then `/thread`
 * 404 two milliseconds later, then 200.
 *
 * Waiting is only justified while this server is itself mid-turn on that
 * id, which is exactly the just-created case -- `createSession` marks the
 * queue running before it returns. Any other unknown id still answers
 * immediately, so a typo or a stale link never hangs the client.
 */
export async function waitForTranscript(
  sessionsDir: string,
  id: string,
  isBusy: (id: string) => boolean,
  options: {
    waitMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | null> {
  const exists = () => {
    const file = sessionMsgFile(sessionsDir, id);
    return file && fs.existsSync(file) ? file : null;
  };

  const immediate = exists();
  if (immediate) return immediate;
  if (!isBusy(id)) return null;

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.waitMs ?? NEW_SESSION_WAIT_MS);
  const pollMs = options.pollMs ?? NEW_SESSION_POLL_MS;

  for (;;) {
    await sleep(pollMs);
    const found = exists();
    if (found) return found;
    // A turn that ended without ever writing a transcript failed outright;
    // there is nothing left to wait for.
    if (now() > deadline || !isBusy(id)) return null;
  }
}
