/**
 * Live streaming: the stdout prose filter, and the thread diff.
 *
 * The stdout fixtures below are not invented. They are the literal chunks
 * captured from a real `aside exec -m claude-sonnet-5 --effort low` turn,
 * with the byte offsets the child actually wrote at -- which is why the
 * escape sequences straddle chunk boundaries in some of them.
 */
import { describe, expect, it } from 'vitest';
import { ProseFilter, stripAnsi } from '../src/prose.js';
import { diffThread, firstDivergence } from '../src/threadstore.js';
import type { ThreadItem } from '../src/thread.js';

const ESC = '\u001b';

/** Exactly what a live turn wrote, chunk by chunk. */
const LIVE_CHUNKS = [
  `${ESC}[2mThinking: `,
  'Time',
  ` to get started on this.${ESC}[0m\n`,
  'A lighthouse is a tall tower structure, usually built near coastlines,',
  ' reefs, or harbor entrances, that uses a powerful rotating light',
  ' to guide ships safely at night.',
  `${ESC}[0m\n`,
  `\n${ESC}[32mbash${ESC}[0m(command: ${ESC}[32m'echo probe-ok'${ESC}[39m, title: ${ESC}[32m'Running probe echo command'${ESC}[39m)\n`,
  `\n${ESC}[2m > probe-ok${ESC}[0m\n`,
  'That',
  "'s the lighthouse rundown.",
  `${ESC}[0m\n`,
];

describe('ProseFilter', () => {
  it('extracts only the answer from a real turn’s stdout', () => {
    const filter = new ProseFilter();
    const out = LIVE_CHUNKS.map((c) => filter.feed(c)).join('');

    expect(out).toContain('A lighthouse is a tall tower structure');
    expect(out).toContain("That's the lighthouse rundown.");

    // None of the chrome survives.
    expect(out).not.toContain('Thinking');
    expect(out).not.toContain('Time to get started');
    expect(out).not.toContain('bash');
    expect(out).not.toContain('echo probe-ok');
    expect(out).not.toContain('probe-ok');
    expect(out).not.toContain('command:');
    expect(out).not.toContain('title:');
  });

  /** No terminal control bytes may reach a React tree. */
  it('never emits an escape byte', () => {
    const filter = new ProseFilter();
    const out = LIVE_CHUNKS.map((c) => filter.feed(c)).join('');
    expect(out).not.toContain(ESC);
    expect(out).not.toMatch(/\[[0-9;]*m/);
  });

  /**
   * A chunk boundary can fall anywhere, including inside `ESC[32m`. The
   * partial sequence has to be held rather than emitted as literal text.
   */
  it('holds a sequence split across chunks', () => {
    const filter = new ProseFilter();
    // The chunk ends mid-sequence; the tail is held, not emitted literally.
    expect(filter.feed(`visible${ESC}[3`)).toBe('visible');
    expect(filter.feed(`2mhidden${ESC}[0m\n`)).toBe('');
    expect(filter.feed('visible again')).toBe('visible again');
  });

  /**
   * Once a line has carried a styled run, the REST of that line is chrome
   * too -- that is how `bash` + `(command: …)` is suppressed, since the
   * tail is emitted at the default attribute. A newline clears it.
   *
   * The trade-off is deliberate: were the daemon ever to print prose after
   * chrome on the same line, that prose would be dropped rather than
   * rendered as garbage, and the transcript would supply it a moment later.
   */
  it('suppresses the remainder of a line that carried chrome', () => {
    const filter = new ProseFilter();
    expect(filter.feed(`${ESC}[2mdim${ESC}[mstill on the chrome line`)).toBe('');
    expect(filter.feed('\nprose on the next line')).toBe('prose on the next line');
  });

  it('drops the newline that terminates a chrome line', () => {
    const filter = new ProseFilter();
    const out = [
      'answer text',
      `${ESC}[0m\n`,
      `${ESC}[32mbash${ESC}[0m(command: 'x')\n`,
      'more answer',
    ]
      .map((c) => filter.feed(c))
      .join('');
    // One newline (from the answer's own line), not two.
    expect(out).toBe('answer text\nmore answer');
  });

  it('treats a bare reset the same as an explicit one', () => {
    const filter = new ProseFilter();
    expect(filter.feed(`${ESC}[2mdim${ESC}[m\nplain`)).toBe('plain');
  });

  it('resets its state between turns', () => {
    const filter = new ProseFilter();
    filter.feed(`${ESC}[2mstill dim`);
    expect(filter.feed('would be swallowed')).toBe('');
    // reset() clears the colour gate AND the tainted-line flag.
    filter.reset();
    expect(filter.feed('a fresh turn')).toBe('a fresh turn');
  });

  it('passes plain output through untouched', () => {
    expect(new ProseFilter().feed('no escapes here')).toBe('no escapes here');
  });
});

describe('stripAnsi', () => {
  it('removes colour from text shown to the user', () => {
    expect(stripAnsi(`${ESC}[31mRequested model x is not available.${ESC}[0m`)).toBe(
      'Requested model x is not available.',
    );
    expect(stripAnsi('plain')).toBe('plain');
    expect(stripAnsi('')).toBe('');
  });
});

// --- thread diffing -------------------------------------------------------

const user = (id: string, text: string): ThreadItem => ({
  kind: 'user',
  id,
  text,
  ts: null,
});
const answer = (id: string, text: string): ThreadItem => ({
  kind: 'answer',
  id,
  text,
  ts: null,
});

describe('thread diff', () => {
  it('sends nothing when nothing changed', () => {
    const items = [user('u1', 'a'), answer('a1', 'b')];
    expect(diffThread(items, [...items])).toBeNull();
  });

  it('sends only the appended tail', () => {
    const prev = [user('u1', 'a')];
    const next = [user('u1', 'a'), answer('a1', 'b')];
    expect(diffThread(prev, next)).toEqual({
      fromIndex: 1,
      items: [answer('a1', 'b')],
      length: 2,
    });
  });

  /**
   * The common case during a turn: the trailing fold grows a step, so only
   * that one item goes over the wire rather than the whole history.
   */
  it('resends from the first item that actually differs', () => {
    const prev = [user('u1', 'a'), answer('a1', 'partial')];
    const next = [user('u1', 'a'), answer('a1', 'complete')];
    const delta = diffThread(prev, next)!;
    expect(delta.fromIndex).toBe(1);
    expect(delta.items).toHaveLength(1);
    expect(delta.length).toBe(2);
  });

  /**
   * A shrink still produces a delta -- it happens when a running fold's
   * trailing text is promoted to an answer -- so the client truncates
   * rather than keeping an orphan.
   */
  it('reports a shrink so the client can truncate', () => {
    const prev = [user('u1', 'a'), answer('a1', 'b'), answer('a2', 'c')];
    const next = [user('u1', 'a')];
    expect(diffThread(prev, next)).toEqual({
      fromIndex: 1,
      items: [],
      length: 1,
    });
  });

  it('sends everything against an empty baseline', () => {
    const next = [user('u1', 'a'), answer('a1', 'b')];
    const delta = diffThread([], next)!;
    expect(delta.fromIndex).toBe(0);
    expect(delta.items).toHaveLength(2);
  });

  it('finds the divergence point', () => {
    expect(firstDivergence([], [])).toBe(0);
    expect(firstDivergence([user('a', 'x')], [user('a', 'x')])).toBe(1);
    expect(firstDivergence([user('a', 'x')], [user('a', 'y')])).toBe(0);
    expect(firstDivergence([user('a', 'x')], [])).toBe(0);
  });
});

/**
 * The CLI's status lines.
 *
 * These open with an UNSTYLED bullet and only then switch colour, so the
 * colour gate alone lets the bullet through. Observed live: a failed turn
 * put a stray "•" into a client's streamed answer.
 */
describe('ProseFilter: CLI status lines', () => {
  it('suppresses a bulleted status line entirely', () => {
    const filter = new ProseFilter();
    const out = filter.feed(
      `\n • ${ESC}[31mError${ESC}[0m Session not found: abc123\nreal answer text`,
    );
    expect(out).not.toContain('•');
    expect(out).not.toContain('Error');
    expect(out).not.toContain('Session not found');
    // Only the answer survives (the leading newline is the empty line the
    // status block was preceded by; the client trims).
    expect(out.trim()).toBe('real answer text');
  });

  it('leaves a bullet in the middle of prose alone', () => {
    const filter = new ProseFilter();
    expect(filter.feed('choose a • or a dash')).toBe('choose a • or a dash');
  });

  it('handles a bullet split from its line by a chunk boundary', () => {
    const filter = new ProseFilter();
    expect(filter.feed('\n ')).toBe('\n ');
    expect(filter.feed('• status text\nprose')).toBe('prose');
  });
});
