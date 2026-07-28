/**
 * Web-side regression tests from the independent audit.
 *
 * Each of these passed against deliberately broken code before it was
 * written -- they close gaps that mutation testing exposed, not gaps that
 * reading the suite would have.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { defaultUrlTransform } from 'react-markdown';
import { applyDelta } from '../src/hooks/useThread';
import { Markdown } from '../src/components/Markdown';
import { WorkFold } from '../src/components/WorkFold';
import type { ThreadItem, WorkStep } from '../src/types';

// vitest is not configured with `globals`, so Testing Library's automatic
// cleanup never registers -- without this, renders from one case are still
// in the document during the next.
afterEach(cleanup);

const answer = (id: string, text: string): ThreadItem => ({
  kind: 'answer',
  id,
  text,
  ts: null,
});

describe('C-2 applyDelta truncates a thread that shrank', () => {
  /**
   * The server sends an authoritative `length`, and a shrinking thread is a
   * real case: it happens whenever a running fold's trailing text is
   * promoted to an answer. `thread-delta.test.ts` never covered it --
   * deleting the truncation branch entirely left all 71 web tests green.
   */
  it('drops orphaned items when the tail is longer than the reported length', () => {
    // `length` is authoritative. This is the case the branch exists for: a
    // client and server that disagree about how long the thread is (a delta
    // applied on top of a stale list after a reconnect). Without the
    // truncation the client keeps items the server has already retired.
    const prev = [
      answer('a', 'one'),
      answer('b', 'two'),
      answer('c', 'three'),
      answer('d', 'four'),
    ];
    const next = applyDelta(prev, {
      fromIndex: 1,
      items: [answer('x', 'x'), answer('y', 'y'), answer('z', 'z')],
      length: 2,
    });
    expect(next.map((i) => i.id)).toEqual(['a', 'x']);
  });

  it('applies a well-formed shrinking delta exactly', () => {
    const prev = [answer('a', 'one'), answer('b', 'two'), answer('c', 'three')];
    const next = applyDelta(prev, {
      fromIndex: 1,
      items: [answer('b2', 'merged')],
      length: 2,
    });
    expect(next.map((i) => i.id)).toEqual(['a', 'b2']);
  });

  it('keeps everything when the thread grew', () => {
    const prev = [answer('a', 'one')];
    const next = applyDelta(prev, {
      fromIndex: 1,
      items: [answer('b', 'two'), answer('c', 'three')],
      length: 3,
    });
    expect(next.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('replaces the whole list when fromIndex is 0', () => {
    const prev = [answer('a', 'one'), answer('b', 'two')];
    const next = applyDelta(prev, {
      fromIndex: 0,
      items: [answer('z', 'fresh')],
      length: 1,
    });
    expect(next.map((i) => i.id)).toEqual(['z']);
  });
});

describe('C-3 assistant markdown cannot carry an executable link', () => {
  /**
   * Transcript text is untrusted (tool output, quoted web pages) and the
   * only thing standing between it and a `javascript:` href is the
   * `urlTransform` in Markdown.tsx. Replacing that whole function with the
   * identity passed all 71 web tests -- the guard was entirely unasserted.
   */
  it('strips a javascript: href out of an answer', () => {
    render(<Markdown text="[click me](javascript:alert(1))" />);
    const link = screen.getByText('click me').closest('a');
    // react-markdown's sanitiser blanks the href rather than dropping the node.
    expect(link?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });

  it('strips a data: href out of an answer', () => {
    render(<Markdown text="[x](data:text/html;base64,PHNjcmlwdD4=)" />);
    const link = screen.getByText('x').closest('a');
    expect(link?.getAttribute('href') ?? '').not.toMatch(/^data:/i);
  });

  it('keeps an ordinary https link, opened safely', () => {
    render(<Markdown text="[docs](https://example.com/a)" />);
    const link = screen.getByText('docs').closest('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('does not render raw HTML from transcript text', () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="alert(1)">\n\nafter'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('after')).toBeTruthy();
  });

  it('the guard it relies on is the real react-markdown sanitiser', () => {
    // Pins the assumption the component is built on, so an upstream change
    // that stops blanking these shows up here rather than in a webview.
    expect(defaultUrlTransform('javascript:alert(1)')).not.toMatch(/^javascript:/i);
  });
});

describe('C-4 a capped image list says so', () => {
  const step = (over: Partial<WorkStep>): WorkStep => ({
    kind: 'step',
    id: 's1',
    icon: 'terminal',
    label: 'Took a screenshot',
    tool: 'bash',
    status: 'success',
    diffstat: null,
    detail: null,
    images: [],
    ...over,
  });

  const block = (steps: WorkStep[]) => ({
    kind: 'work' as const,
    id: 'w1',
    items: steps,
    durationMs: 1000,
    running: false,
  });

  const fold = (steps: WorkStep[]) => (
    <WorkFold
      block={block(steps)}
      live
      subagentSteps={{}}
      onInspectSubagent={() => {}}
      sources={{}}
      onOpenCitation={() => {}}
    />
  );

  it('reports the images the server left out', () => {
    render(fold([step({ images: ['data:image/png;base64,AAA'], imagesDropped: 7 })]));
    expect(screen.getByText(/7 more images not shown/)).toBeTruthy();
  });

  it('uses the singular for one dropped image', () => {
    render(fold([step({ images: [], imagesDropped: 1 })]));
    expect(screen.getByText(/1 more image not shown/)).toBeTruthy();
  });

  it('says nothing when every image came through', () => {
    render(fold([step({ images: ['data:image/png;base64,AAA'] })]));
    expect(screen.queryByText(/not shown/)).toBeNull();
  });
});
