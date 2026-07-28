/**
 * The client half of the live thread: applying a tail delta, and retiring
 * the optimistic echo.
 *
 * These two are pure functions precisely so they can be tested without a
 * DOM -- they are where a subtle bug would show up as a duplicated or
 * vanishing message, which is the failure the owner would notice first.
 */
import { describe, expect, it } from 'vitest';
import { applyDelta, pendingIsEchoed } from '../src/hooks/useThread';
import type { ThreadItem } from '../src/types';

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

describe('applyDelta', () => {
  it('appends a delta that only adds', () => {
    const next = applyDelta([user('u1', 'hi')], {
      fromIndex: 1,
      items: [answer('a1', 'hello')],
      length: 2,
    });
    expect(next.map((i) => i.id)).toEqual(['u1', 'a1']);
  });

  it('replaces from the divergence point', () => {
    const next = applyDelta([user('u1', 'hi'), answer('a1', 'part')], {
      fromIndex: 1,
      items: [answer('a1', 'complete')],
      length: 2,
    });
    expect(next).toHaveLength(2);
    expect((next[1] as any).text).toBe('complete');
  });

  /**
   * A shrink happens when a running fold's trailing text is promoted to an
   * answer. Without honouring `length` the client would keep an orphaned
   * item on screen forever.
   */
  it('truncates when the thread shrank', () => {
    const next = applyDelta(
      [user('u1', 'hi'), answer('a1', 'x'), answer('a2', 'y')],
      { fromIndex: 1, items: [], length: 1 },
    );
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('u1');
  });

  it('replaces everything on a full resync', () => {
    const next = applyDelta([user('old', 'stale')], {
      fromIndex: 0,
      items: [user('u1', 'fresh'), answer('a1', 'reply')],
      length: 2,
    });
    expect(next.map((i) => i.id)).toEqual(['u1', 'a1']);
  });

  it('ignores a negative index rather than throwing', () => {
    const next = applyDelta([user('u1', 'hi')], {
      fromIndex: -3,
      items: [user('u1', 'hi')],
      length: 1,
    });
    expect(next).toHaveLength(1);
  });
});

describe('pendingIsEchoed', () => {
  const pending = (text: string) => ({ text, attachments: [], at: 0 });

  it('is not echoed while the thread has not caught up', () => {
    expect(pendingIsEchoed([], pending('my question'))).toBe(false);
    expect(
      pendingIsEchoed([user('u1', 'an older question')], pending('my question')),
    ).toBe(false);
  });

  it('is echoed once the transcript carries the same text', () => {
    expect(
      pendingIsEchoed(
        [user('u1', 'older'), user('u2', 'my question')],
        pending('my question'),
      ),
    ).toBe(true);
  });

  /**
   * With attachments the server prepends a header, so the transcript's copy
   * CONTAINS the typed text rather than equalling it. Missing this would
   * leave a duplicate bubble on every message that carried a file.
   */
  it('matches through the attachment header', () => {
    const stored = user(
      'u2',
      '[user sent 1 file from their phone, saved to: /a/b.png] look at this',
    );
    expect(pendingIsEchoed([stored], pending('look at this'))).toBe(true);
  });

  /**
   * Only the NEWEST user bubble can be the echo. Scanning further back
   * would match the same question asked earlier in the session and drop the
   * bubble the user is waiting to see.
   */
  it('does not match an identical message from an earlier turn', () => {
    const items = [
      user('u1', 'run the tests'),
      answer('a1', 'done'),
      user('u2', 'something else'),
    ];
    expect(pendingIsEchoed(items, pending('run the tests'))).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    expect(
      pendingIsEchoed([user('u1', '  spaced  ')], pending('spaced')),
    ).toBe(true);
  });

  it('never matches an empty pending message against anything', () => {
    expect(pendingIsEchoed([user('u1', 'anything')], pending(''))).toBe(false);
  });
});
