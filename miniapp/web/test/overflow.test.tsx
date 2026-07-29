/**
 * Regression tests for the horizontal-overflow bug a user hit in the
 * field: a model id like `oc/deepseek-v4-flash-free(max)` made the
 * composer's model pill wider than the phone, which panned the ENTIRE app
 * sideways in Telegram's webview -- every screen was cut off at the left
 * edge.
 *
 * jsdom does no layout, so the width math itself cannot be asserted here.
 * What can be pinned is the contract that makes the layout safe:
 *
 * 1. The stylesheet rules that let a pill shrink and ellipsize, clamp the
 *    root against horizontal panning, and truncate the subagent model
 *    badge. These are load-bearing lines of CSS; losing any one of them
 *    in a refactor re-opens the bug silently.
 * 2. The DOM shape those rules select on: the label lives in
 *    `.pill-label`, the effort pill opts out of shrinking via
 *    `.pill-effort`, and the subagent badge wraps its text in
 *    `.subagent-model-label`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Composer } from '../src/components/Composer';
import type { PillState } from '../src/components/Composer';

afterEach(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const componentsCss = readFileSync(
  path.join(here, '../src/theme/components.css'),
  'utf8',
);
const baseCss = readFileSync(
  path.join(here, '../src/theme/base.css'),
  'utf8',
);

/**
 * Every declaration applied to a selector, across all of its rules, with
 * comments stripped -- a comment MENTIONING `flex: none` must not read as
 * the declaration itself.
 */
function ruleBody(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `(?:^|\\n)(?:[^{}\\n]*,\\s*\\n)*${escaped}(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}`,
    'g',
  );
  let body = '';
  for (const match of bare.matchAll(rule)) body += match[1];
  return body;
}

const LONG_MODEL = 'oc/deepseek-v4-flash-free(max)';

const pills: PillState = {
  modelLabel: LONG_MODEL,
  effortLabel: 'High',
  effortId: 'high',
  provider: 'openrouter',
};

function renderComposer() {
  return render(
    <Composer
      variant="home"
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      pills={pills}
      onOpenModel={vi.fn()}
      onOpenEffort={vi.fn()}
      onOpenPermission={vi.fn()}
      permissionMode="guard"
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
    />,
  );
}

describe('the pill cannot widen the app', () => {
  it('.pill shrinks instead of overflowing', () => {
    const body = ruleBody(componentsCss, '.pill');
    expect(body).toContain('min-width: 0');
    expect(body).toContain('flex: 0 1 auto');
    expect(body).toContain('max-width: 100%');
    expect(body).not.toContain('flex: none');
  });

  it('.pill-label ellipsizes', () => {
    const body = ruleBody(componentsCss, '.pill-label');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('text-overflow: ellipsis');
  });

  it('the effort pill opts back out of shrinking', () => {
    expect(ruleBody(componentsCss, '.pill-effort')).toContain('flex: none');
  });

  it('the long model id renders inside .pill-label, the effort pill carries .pill-effort', () => {
    const { container } = renderComposer();
    const labels = Array.from(container.querySelectorAll('.pill-label'));
    expect(labels.map((el) => el.textContent)).toContain(LONG_MODEL);

    const effort = Array.from(container.querySelectorAll('.pill')).find((el) =>
      el.textContent?.includes('High'),
    );
    expect(effort?.classList.contains('pill-effort')).toBe(true);

    const model = Array.from(container.querySelectorAll('.pill')).find((el) =>
      el.textContent?.includes(LONG_MODEL),
    );
    expect(model?.classList.contains('pill-effort')).toBe(false);
  });
});

describe('the root clamps horizontal panning', () => {
  it('html/body carry overflow-x: hidden', () => {
    // The guard is one rule on `html, body`; match it wherever it lives.
    expect(baseCss).toMatch(
      /html,\s*\nbody\s*\{[^}]*overflow-x:\s*hidden/,
    );
  });
});

describe('the subagent model badge truncates', () => {
  it('.subagent-model shrinks and its label ellipsizes', () => {
    const badge = ruleBody(componentsCss, '.subagent-model');
    expect(badge).toContain('flex: 0 1 auto');
    expect(badge).toContain('min-width: 0');

    const label = ruleBody(componentsCss, '.subagent-model-label');
    expect(label).toContain('overflow: hidden');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('white-space: nowrap');
  });
});
