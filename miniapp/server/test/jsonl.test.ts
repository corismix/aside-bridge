/**
 * Full-history parsing, and the thread it builds.
 *
 * This is the regression suite for the session that rendered as one bare
 * fold. Its cause was not the grouping rules -- it was the SOURCE.
 * `aside.sessions.messages(id)` returns the agent's current CONTEXT, so on
 * a long session it begins mid-conversation: a `system-message` with a
 * STRING body, one user message, then a wall of tool activity, with the
 * earlier turns gone. The fixtures below reproduce each of those shapes.
 */
import { describe, expect, it } from 'vitest';
import { normalizeTimestamp, parseHistory } from '../src/jsonl.js';
import { buildThread } from '../src/thread.js';

const line = (obj: unknown) => JSON.stringify(obj);

describe('parseHistory', () => {
  it('reads a plain conversation', () => {
    const messages = parseHistory(
      [
        line({ role: 'user', content: 'hello', timestamp: 1767312000 }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1767312001,
        }),
      ].join('\n'),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('hello');
    // Seconds on disk, milliseconds everywhere above it.
    expect(messages[0].timestamp).toBe(1767312000000);
  });

  /** The CLI writes user bodies as bare strings, not part arrays. */
  it('accepts a string content body', () => {
    const [msg] = parseHistory(line({ role: 'user', content: 'plain string' }));
    expect(msg.content).toBe('plain string');
  });

  /** The browser hides these; so do we. */
  it('drops system-message records', () => {
    const messages = parseHistory(
      [
        line({
          role: 'system-message',
          kind: 'site_skill',
          content: 'Relevant skill docs are available.',
          timestamp: 1767312000,
        }),
        line({ role: 'user', content: 'the real question' }),
      ].join('\n'),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  /**
   * `user-message-metadata` PRECEDES the user message it belongs to and
   * carries that message's attachments, so it is folded forward rather than
   * surfaced as a row of its own.
   */
  it('folds attachment metadata onto the following user message', () => {
    const messages = parseHistory(
      [
        line({
          role: 'user-message-metadata',
          attachments: [
            {
              id: 'x',
              type: 'file',
              name: 'Screenshot.png',
              mimeType: 'image/png',
              path: './attachments/Screenshot.png',
            },
          ],
          timestamp: 1767312000,
        }),
        line({ role: 'user', content: 'look at this', timestamp: 1767312001 }),
      ].join('\n'),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].attachments).toEqual([
      { name: 'Screenshot.png', mimeType: 'image/png' },
    ]);
  });

  it('carries tool result fields through unchanged', () => {
    const [msg] = parseHistory(
      line({
        role: 'toolResult',
        toolCallId: 'toolu_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'output' }],
        details: { diff: '+a\n-b' },
        isError: true,
        timestamp: 1767312002,
      }),
    );
    expect(msg.toolName).toBe('bash');
    expect(msg.toolCallId).toBe('toolu_1');
    expect(msg.isError).toBe(true);
    expect(msg.details).toEqual({ diff: '+a\n-b' });
  });

  it('skips corrupt lines instead of failing the read', () => {
    const messages = parseHistory(
      ['{not json', '', line({ role: 'user', content: 'survived' })].join('\n'),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('survived');
  });

  it('normalises both timestamp encodings', () => {
    expect(normalizeTimestamp(1767312000)).toBe(1767312000000);
    expect(normalizeTimestamp(1767312000000)).toBe(1767312000000);
    expect(normalizeTimestamp(0)).toBeUndefined();
    expect(normalizeTimestamp('nope')).toBeUndefined();
  });
});

describe('buildThread over full history', () => {
  /**
   * The acceptance shape: several user bubbles, one fold per work block,
   * and each turn's final answer -- rather than the single fold the facade
   * source produced.
   */
  it('renders every turn of a multi-turn session', () => {
    const messages = parseHistory(
      [
        line({ role: 'system-message', content: 'skill hint', timestamp: 1 }),
        line({ role: 'user', content: 'first question', timestamp: 10 }),
        line({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'Ran a check' } },
          ],
          timestamp: 11,
        }),
        line({
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          timestamp: 12,
        }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'first answer' }],
          timestamp: 13,
        }),
        line({ role: 'user', content: 'second question', timestamp: 20 }),
        line({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c2', name: 'read_file', arguments: { path: '/a/b.ts' } }],
          timestamp: 21,
        }),
        line({
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'contents' }],
          timestamp: 22,
        }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'second answer' }],
          timestamp: 23,
        }),
      ].join('\n'),
    );

    const items = buildThread(messages);
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'work',
      'answer',
      'user',
      'work',
      'answer',
    ]);
    expect((items[0] as any).text).toBe('first question');
    expect((items[2] as any).text).toBe('first answer');
    expect((items[3] as any).text).toBe('second question');
    expect((items[5] as any).text).toBe('second answer');
    // Thinking is never surfaced, here or anywhere.
    expect(JSON.stringify(items)).not.toContain('hidden');
  });

  /**
   * A compacted tail begins with tool activity and no user message in
   * front of it. That must render as a fold and an answer, not vanish --
   * this is the exact shape the facade was handing back.
   */
  it('renders a turn that does not start with a user message', () => {
    const messages = parseHistory(
      [
        line({ role: 'system-message', content: 'injected context' }),
        line({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'Mid-turn work' } }],
          timestamp: 11,
        }),
        line({
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'done' }],
          timestamp: 12,
        }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'the tail answer' }],
          timestamp: 13,
        }),
        line({ role: 'user', content: 'a later question', timestamp: 20 }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'a later answer' }],
          timestamp: 21,
        }),
      ].join('\n'),
    );

    const items = buildThread(messages);
    expect(items.map((i) => i.kind)).toEqual([
      'work',
      'answer',
      'user',
      'answer',
    ]);
    expect((items[1] as any).text).toBe('the tail answer');
  });

  /** An assistant record whose body is a string still produces its answer. */
  it('does not lose an answer written as a bare string', () => {
    const items = buildThread(
      parseHistory(
        [
          line({ role: 'user', content: 'q', timestamp: 10 }),
          line({ role: 'assistant', content: 'a string answer', timestamp: 11 }),
        ].join('\n'),
      ),
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'answer']);
    expect((items[1] as any).text).toBe('a string answer');
  });

  it('puts attachments on the user bubble', () => {
    const items = buildThread(
      parseHistory(
        [
          line({
            role: 'user-message-metadata',
            attachments: [
              { name: 'a.png', mimeType: 'image/png' },
              { name: 'b.pdf', mimeType: 'application/pdf' },
            ],
          }),
          line({ role: 'user', content: 'these two', timestamp: 10 }),
        ].join('\n'),
      ),
    );
    expect((items[0] as any).attachments).toEqual([
      { name: 'a.png', mimeType: 'image/png' },
      { name: 'b.pdf', mimeType: 'application/pdf' },
    ]);
  });

  it('keeps a bubble for an attachments-only message', () => {
    const items = buildThread(
      parseHistory(
        [
          line({ role: 'user-message-metadata', attachments: [{ name: 'a.png' }] }),
          line({ role: 'user', content: '', timestamp: 10 }),
        ].join('\n'),
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('user');
    expect((items[0] as any).attachments).toHaveLength(1);
  });

  it('marks only the last fold as running', () => {
    const items = buildThread(
      parseHistory(
        [
          line({ role: 'user', content: 'one', timestamp: 10 }),
          line({
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'A' } }],
            timestamp: 11,
          }),
          line({ role: 'user', content: 'two', timestamp: 20 }),
          line({
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { title: 'B' } }],
            timestamp: 21,
          }),
        ].join('\n'),
      ),
      true,
    );
    const folds = items.filter((i) => i.kind === 'work') as any[];
    expect(folds).toHaveLength(2);
    expect(folds[0].running).toBe(false);
    expect(folds[1].running).toBe(true);
  });
});
