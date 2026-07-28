/**
 * Live tail of a session's messages.jsonl.
 *
 * fs.watch is the fast path and a 1.5s poll is the fallback (fs.watch is
 * unreliable across editors/atomic renames, and the file may not exist yet
 * for a session the CLI is still creating). Reads are byte-offset based and
 * stop at the last newline, so a half-written final line is simply picked up
 * on the next pass -- the same guarantee bridge.py's `stream_new` relies on.
 */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { TranscriptParser, type TranscriptEntry } from './transcript.js';

/**
 * Poll floor. fs.watch is the fast path and normally fires first; this is
 * the backstop for the cases where it does not (atomic renames, network
 * volumes). Round 3 tightened it from 1.5s to 800ms so the worst-case
 * latency from a transcript write to a client update stays under a second
 * even when fs.watch is asleep.
 */
const POLL_MS = 800;
const NEWLINE = 0x0a;

export class SessionWatcher extends EventEmitter {
  private bytePos = 0;
  private lineNo = 0;
  private parser = new TranscriptParser();
  private timer: NodeJS.Timeout | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private started = false;
  refs = 0;

  constructor(
    readonly sessionId: string,
    readonly msgFile: string,
  ) {
    super();
  }

  /** Highest line index consumed so far (-1 when nothing has been read). */
  get lastLine(): number {
    return this.lineNo - 1;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Prime silently: everything already on disk is backlog the client
    // fetches over REST, but the parser still needs it for subagent state.
    this.consume(false);
    this.timer = setInterval(() => this.consume(true), POLL_MS);
    this.timer.unref?.();
    this.attachFsWatch();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.removeAllListeners();
  }

  private attachFsWatch(): void {
    try {
      this.fsWatcher = fs.watch(this.msgFile, () => this.consume(true));
      this.fsWatcher.on('error', () => {
        this.fsWatcher?.close();
        this.fsWatcher = null; // the interval keeps us honest
      });
    } catch {
      // file not created yet -- polling covers it, and we retry on each pass
    }
  }

  private consume(emit: boolean): void {
    const stat = fs.statSync(this.msgFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) return;
    if (!this.fsWatcher) this.attachFsWatch();

    if (stat.size < this.bytePos) {
      // truncated or replaced: start over rather than emit garbage
      this.bytePos = 0;
      this.lineNo = 0;
      this.parser = new TranscriptParser();
    }
    if (stat.size <= this.bytePos) return;

    let chunk: Buffer;
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.msgFile, 'r');
      const length = stat.size - this.bytePos;
      chunk = Buffer.alloc(length);
      const read = fs.readSync(fd, chunk, 0, length, this.bytePos);
      chunk = chunk.subarray(0, read);
    } catch {
      return;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }

    const lastNewline = chunk.lastIndexOf(NEWLINE);
    if (lastNewline < 0) return; // only a partial line so far

    const consumed = lastNewline + 1;
    const text = chunk.subarray(0, consumed).toString('utf8');
    const lines = text.split('\n');
    lines.pop(); // trailing "" produced by the final newline

    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      entries.push(...this.parser.feedLine(line, this.lineNo));
      this.lineNo += 1;
    }
    this.bytePos += consumed;

    if (emit && entries.length) this.emit('entries', entries);
  }
}

/** One watcher per session, shared by every subscriber, refcounted. */
export class WatcherRegistry {
  private watchers = new Map<string, SessionWatcher>();

  acquire(sessionId: string, msgFile: string): SessionWatcher {
    let watcher = this.watchers.get(sessionId);
    if (!watcher) {
      watcher = new SessionWatcher(sessionId, msgFile);
      this.watchers.set(sessionId, watcher);
      watcher.start();
    }
    watcher.refs += 1;
    return watcher;
  }

  release(sessionId: string): void {
    const watcher = this.watchers.get(sessionId);
    if (!watcher) return;
    watcher.refs -= 1;
    if (watcher.refs <= 0) {
      watcher.stop();
      this.watchers.delete(sessionId);
    }
  }

  closeAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
  }
}
