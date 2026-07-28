/**
 * Round 6, web side: local image paths in answers, and creature colours.
 *
 * The bug this closes was visible rather than theoretical -- an answer
 * containing `![shot](/Users/…/shot.png)` drew the browser's broken-image
 * icon, while the same screenshot rendered fine in the work timeline
 * below it (those are transcript data URIs). So the tests are about what
 * ends up in the DOM: a rewritten src for a local path, an untouched one
 * for anything remote, and a caption instead of a broken icon when the
 * route says no.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown';
import { Creature, HUES, creatureHue } from '../src/components/Creature';
import { localImagePath } from '../src/utils/images';
import { setAuthToken } from '../src/api';

afterEach(cleanup);

const SHOT = '/Users/owner/.aside/u/0/sessions/2026-01-07_abc/artifacts/shot.png';

describe('telling a local path apart from a URL', () => {
  it('accepts an absolute filesystem path', () => {
    expect(localImagePath(SHOT)).toBe(SHOT);
    expect(localImagePath('/tmp/a b.png')).toBe('/tmp/a b.png');
  });

  it('unwraps a file:// URL to the path it names', () => {
    expect(localImagePath('file:///Users/owner/shot.png')).toBe(
      '/Users/owner/shot.png',
    );
    expect(localImagePath('file://localhost/Users/owner/shot.png')).toBe(
      '/Users/owner/shot.png',
    );
    expect(localImagePath('file:///Users/owner/a%20b.png')).toBe(
      '/Users/owner/a b.png',
    );
  });

  it('leaves every real URL alone', () => {
    for (const url of [
      'https://example.com/logo.png',
      'http://example.com/logo.png',
      'data:image/png;base64,AAAA',
      'blob:https://example.com/1234',
      '//cdn.example.com/logo.png',
      'shot.png',
      'artifacts/shot.png',
      './shot.png',
      '',
    ]) {
      expect(localImagePath(url), url).toBeNull();
    }
  });
});

describe('images inside an answer', () => {
  it('points a local absolute path at the session file route', () => {
    setAuthToken('tok-123');
    render(<Markdown text={`![a shot](${SHOT})`} sessionId="abc" />);
    const img = screen.getByAltText('a shot') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(
      `/api/sessions/abc/file?path=${encodeURIComponent(SHOT)}&token=tok-123`,
    );
    // Lazily fetched: an answer with a dozen screenshots costs nothing
    // until they scroll into view.
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('leaves an https image exactly as written', () => {
    render(
      <Markdown text="![logo](https://example.com/logo.png)" sessionId="abc" />,
    );
    expect(screen.getByAltText('logo').getAttribute('src')).toBe(
      'https://example.com/logo.png',
    );
  });

  it('rewrites a file:// src the same way', () => {
    setAuthToken('tok-123');
    render(
      <Markdown text="![f](file:///Users/owner/shot.png)" sessionId="abc" />,
    );
    expect(screen.getByAltText('f').getAttribute('src')).toContain(
      encodeURIComponent('/Users/owner/shot.png'),
    );
  });

  it('shows a caption, not a broken icon, when the fetch fails', () => {
    setAuthToken('tok-123');
    render(<Markdown text={`![a shot](${SHOT})`} sessionId="abc" />);
    fireEvent.error(screen.getByAltText('a shot'));
    expect(screen.queryByAltText('a shot')).toBeNull();
    expect(screen.getByText('Image unavailable: a shot')).toBeTruthy();
  });

  it('keeps the failure across a re-render instead of re-requesting', () => {
    // react-markdown uses the `components` map entries AS element types, so
    // an inline arrow there remounts every image on every render -- which
    // on a streaming answer means re-fetching a file that already 404'd,
    // several times a second.
    setAuthToken('tok-123');
    // A fresh `sources` object each time, which is what a live thread does
    // on every meta push -- and what gets past the memo() on Markdown.
    const draw = () => (
      <Markdown text={`![a shot](${SHOT})`} sessionId="abc" sources={{}} />
    );
    const { rerender } = render(draw());
    fireEvent.error(screen.getByAltText('a shot'));
    rerender(draw());
    rerender(draw());
    expect(screen.queryByAltText('a shot')).toBeNull();
    expect(screen.getByText('Image unavailable: a shot')).toBeTruthy();
  });

  it('shows the caption when there is no session to resolve against', () => {
    // The artifact markdown viewer always has one; a caller that does not
    // must degrade to the caption rather than emit a src the webview will
    // try, and fail, to read off a filesystem it does not have.
    render(<Markdown text={`![a shot](${SHOT})`} />);
    expect(screen.queryByAltText('a shot')).toBeNull();
    expect(screen.getByText('Image unavailable: a shot')).toBeTruthy();
  });

  it('still refuses javascript: in an ordinary link', () => {
    render(<Markdown text="[x](javascript:alert(1))" sessionId="abc" />);
    const link = document.querySelector('a');
    expect(link?.getAttribute('href') || '').not.toContain('javascript:');
  });
});

describe('creature colours', () => {
  it('maps each palette slot to its own hue, and wraps', () => {
    const slots = HUES.map((_, index) => creatureHue(index));
    expect(new Set(slots).size).toBe(HUES.length);
    expect(creatureHue(HUES.length)).toBe(creatureHue(0));
    // A child with no slot yet must still draw something.
    expect(creatureHue(undefined)).toBe(HUES[0]);
  });

  it('draws two different slots in two different colours', () => {
    const { container } = render(
      <>
        <Creature slot={0} />
        <Creature slot={1} />
      </>,
    );
    const fills = Array.from(container.querySelectorAll('path')).map((p) =>
      p.getAttribute('fill'),
    );
    expect(fills).toHaveLength(2);
    expect(fills[0]).not.toBe(fills[1]);
  });
});
