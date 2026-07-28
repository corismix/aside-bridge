/**
 * Round 5 client logic: citations, the streaming markdown guard, the fold's
 * settle rule, and the compact formatters.
 *
 * The invariant worth pinning above all others is that a raw `<citation>`
 * tag never survives into what is rendered -- that is the bug this feature
 * exists to fix, and it is easy to reintroduce by taking a shortcut on an
 * unresolvable ref.
 */
import { describe, expect, it } from 'vitest';
import {
  citationIndexFrom,
  citationHref,
  dropPartialCitation,
  superscript,
  transformCitations,
} from '../src/utils/citations';
import { closeOpenFence } from '../src/utils/markdown';
import { formatBytes, formatTokens } from '../src/utils/format';
import { foldIsLive } from '../src/components/Thread';
import { creatureHue } from '../src/components/Creature';
import type { ThreadItem } from '../src/types';

const known = (...ids: string[]) => (ref: string) => ids.includes(ref);

describe('transformCitations', () => {
  it('keeps the supporting text and appends a chip for a known source', () => {
    const { markdown, marks } = transformCitations(
      'Founded in 2025. <citation refs="abc">They were at Airbridge</citation>',
      known('abc'),
    );
    expect(markdown).toBe('Founded in 2025. They were at Airbridge[¹](cite:1)');
    expect(marks).toEqual([{ index: 1, refs: ['abc'], quote: '' }]);
  });

  it('lifts a <quote> body out of the prose and into the mark', () => {
    const { markdown, marks } = transformCitations(
      'Trusted by many.<citation refs="abc"><quote>9.6 Million+ Researchers</quote></citation> Gap: none.',
      known('abc'),
    );
    expect(markdown).toBe('Trusted by many.[¹](cite:1) Gap: none.');
    expect(marks[0].quote).toBe('9.6 Million+ Researchers');
  });

  it('renders an unresolvable ref as plain prose with no chip', () => {
    const { markdown, marks } = transformCitations(
      'A claim. <citation refs="s1">local marker</citation>',
      known('abc'),
    );
    expect(markdown).toBe('A claim. local marker');
    expect(marks).toEqual([]);
  });

  it('keeps only the refs that resolve, in a multi-ref tag', () => {
    const { marks } = transformCitations(
      '<citation refs="abc, s1 ,def">text</citation>',
      known('abc', 'def'),
    );
    expect(marks[0].refs).toEqual(['abc', 'def']);
  });

  it('numbers chips in document order', () => {
    const { markdown, marks } = transformCitations(
      '<citation refs="abc">one</citation> and <citation refs="def">two</citation>',
      known('abc', 'def'),
    );
    expect(markdown).toBe('one[¹](cite:1) and two[²](cite:2)');
    expect(marks.map((m) => m.index)).toEqual([1, 2]);
  });

  it('never leaves a raw tag behind, resolvable or not', () => {
    const inputs = [
      '<citation refs="abc">a</citation>',
      '<citation refs="nope">b</citation>',
      'plain <citation refs="abc"><quote>q</quote></citation> text',
    ];
    for (const input of inputs) {
      const { markdown } = transformCitations(input, known('abc'));
      expect(markdown).not.toContain('<citation');
      expect(markdown).not.toContain('</citation>');
      expect(markdown).not.toContain('<quote>');
    }
  });

  it('leaves text with no citations untouched', () => {
    const { markdown, marks } = transformCitations('Just prose.', known('abc'));
    expect(markdown).toBe('Just prose.');
    expect(marks).toEqual([]);
  });

  it('round-trips a chip href back to its index', () => {
    expect(citationIndexFrom(citationHref(3))).toBe(3);
    expect(citationIndexFrom('https://example.com')).toBeNull();
  });

  it('superscripts multi-digit numbers digit by digit', () => {
    expect(superscript(1)).toBe('¹');
    expect(superscript(12)).toBe('¹²');
  });
});

describe('dropPartialCitation', () => {
  it('hides a tag that has not finished arriving', () => {
    expect(dropPartialCitation('Founded in 2025. <citat')).toBe(
      'Founded in 2025. ',
    );
    expect(dropPartialCitation('Founded. <citation refs="ab')).toBe('Founded. ');
    expect(dropPartialCitation('Founded. <citation refs="ab">part')).toBe(
      'Founded. ',
    );
  });

  it('keeps a tag that is already closed', () => {
    const text = 'A. <citation refs="ab">done</citation> B.';
    expect(dropPartialCitation(text)).toBe(text);
  });

  it('keeps a closed tag and drops only the one still arriving', () => {
    expect(
      dropPartialCitation('<citation refs="a">one</citation> then <citation ref'),
    ).toBe('<citation refs="a">one</citation> then ');
  });

  it('leaves text with no tag alone', () => {
    expect(dropPartialCitation('nothing here')).toBe('nothing here');
  });
});

describe('closeOpenFence', () => {
  it('closes a fence the buffer is still inside', () => {
    expect(closeOpenFence('text\n```ts\nconst a = 1')).toBe(
      'text\n```ts\nconst a = 1\n```',
    );
  });

  it('leaves a balanced buffer alone', () => {
    const text = 'text\n```ts\nconst a = 1\n```\nmore';
    expect(closeOpenFence(text)).toBe(text);
  });

  it('handles tilde fences', () => {
    expect(closeOpenFence('~~~\nbody')).toBe('~~~\nbody\n~~~');
  });

  it('does not touch inline code or plain prose', () => {
    expect(closeOpenFence('use `npm test` to run')).toBe('use `npm test` to run');
  });
});

describe('foldIsLive', () => {
  const work = (running: boolean): ThreadItem => ({
    kind: 'work',
    id: 'w',
    items: [],
    durationMs: 0,
    running,
  });
  const answer: ThreadItem = { kind: 'answer', id: 'a', text: 'done', ts: null };
  const streaming: ThreadItem = { kind: 'streaming', id: 's', text: 'part' };

  it('keeps a running fold open while there is no answer yet', () => {
    expect(foldIsLive([work(true)], 0)).toBe(true);
  });

  it('settles the fold once the answer starts streaming', () => {
    expect(foldIsLive([work(true), streaming], 0)).toBe(false);
  });

  it('settles the fold once the transcript has promoted an answer', () => {
    expect(foldIsLive([work(true), answer], 0)).toBe(false);
  });

  it('never opens a finished fold', () => {
    expect(foldIsLive([work(false)], 0)).toBe(false);
  });
});

describe('creatureHue', () => {
  it('is stable for a seed, so a subagent keeps its colour', () => {
    expect(creatureHue('toolu_01WNgPXjaXP4vgZtHXyFiVgK')).toBe(
      creatureHue('toolu_01WNgPXjaXP4vgZtHXyFiVgK'),
    );
  });

  /**
   * The first palette had 180 and 210 in it, and two sibling subagents in a
   * live run landed on them -- both read as "the cyan one". Whatever any two
   * seeds hash to now, they cannot be that close.
   */
  it('never puts two hues closer together than 45 degrees', () => {
    const hues = [...new Set(
      Array.from({ length: 200 }, (_, i) => creatureHue(`toolu_seed_${i}`)),
    )].sort((a, b) => a - b);
    for (let i = 1; i < hues.length; i += 1) {
      expect(hues[i] - hues[i - 1]).toBeGreaterThanOrEqual(45);
    }
  });
});

describe('compact formatters', () => {
  it('prints tokens the way Aside does', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(506)).toBe('506');
    expect(formatTokens(1400)).toBe('1.4k');
    expect(formatTokens(2000)).toBe('2k');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(285_000)).toBe('285k');
  });

  it('prints file sizes', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(12_000)).toBe('12 KB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
  });
});
