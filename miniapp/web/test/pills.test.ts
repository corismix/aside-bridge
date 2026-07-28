/**
 * Pill precedence.
 *
 * Two rules, and the pills are wrong in a user-visible way if either slips:
 * with no local pick they must show the DAEMON's account default (what the
 * browser would use), and with a pick they must name the PICKED model --
 * never the daemon's, which is what the label fallback used to do.
 */
import { describe, expect, it } from 'vitest';
import { catalogLabel, resolvePills } from '../src/utils/pills';
import type { StatusResponse } from '../src/types';

const CATALOG = [
  {
    id: 'claude-code',
    label: 'Claude',
    connected: true,
    models: [
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    ],
  },
  {
    id: 'openai-codex',
    label: 'ChatGPT',
    connected: false,
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
  },
];

/** A status payload shaped like the real one, with the daemon on Fable 5. */
const status = (over: Partial<StatusResponse> = {}): StatusResponse =>
  ({
    uptimeMs: 1,
    inFlight: [],
    queued: {},
    catalog: CATALOG,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    effortMenu: [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra High' },
    ],
    permissionMenu: [],
    uploads: { maxFiles: 5, maxBytes: 1 },
    defaults: {
      provider: 'claude-code',
      modelId: 'claude-fable-5',
      modelLabel: 'Fable 5',
      effort: 'high',
      effortLabel: 'High',
    },
    permission: 'Guard',
    ...over,
  }) as StatusResponse;

const noPick = { provider: '', modelId: '', effort: '' };

describe('no local pick', () => {
  /** The round-4 complaint: the pills must not show a bridge-config guess. */
  it('mirrors the daemon default', () => {
    const pills = resolvePills(status(), noPick);
    expect(pills.provider).toBe('claude-code');
    expect(pills.modelId).toBe('claude-fable-5');
    expect(pills.modelLabel).toBe('Fable 5');
    expect(pills.effortId).toBe('high');
    expect(pills.effortLabel).toBe('High');
  });

  it('follows the daemon when its default changes', () => {
    const pills = resolvePills(
      status({
        defaults: {
          provider: 'openai-codex',
          modelId: 'gpt-5.5',
          modelLabel: 'GPT-5.5',
          effort: 'xhigh',
          effortLabel: 'Extra High',
        },
      } as Partial<StatusResponse>),
      noPick,
    );
    expect(pills.modelLabel).toBe('GPT-5.5');
    expect(pills.effortLabel).toBe('Extra High');
  });

  /** Before /api/status answers there is nothing to show but a placeholder. */
  it('degrades to a placeholder with no status yet', () => {
    const pills = resolvePills(null, noPick);
    expect(pills.modelLabel).toBe('Model');
    expect(pills.effortId).toBe('high');
    expect(pills.modelId).toBe('');
  });
});

describe('an explicit local pick overrides', () => {
  it('wins over the daemon default', () => {
    const pills = resolvePills(status(), {
      provider: 'claude-code',
      modelId: 'claude-sonnet-5',
      effort: 'low',
    });
    expect(pills.modelId).toBe('claude-sonnet-5');
    expect(pills.modelLabel).toBe('Sonnet 5');
    expect(pills.effortId).toBe('low');
    expect(pills.effortLabel).toBe('Low');
  });

  /**
   * The bug this file exists for. The label used to start at the daemon
   * default's label and was only replaced on a catalog hit -- so picking a
   * model the catalog does not list showed "Fable 5" while running
   * something else entirely.
   */
  it('names the picked model even when the catalog does not list it', () => {
    const pills = resolvePills(status(), {
      provider: 'claude-code',
      modelId: 'claude-opus-9-unreleased',
      effort: '',
    });
    expect(pills.modelId).toBe('claude-opus-9-unreleased');
    expect(pills.modelLabel).toBe('claude-opus-9-unreleased');
    expect(pills.modelLabel).not.toBe('Fable 5');
  });

  it('names the picked model when its provider is unknown', () => {
    const pills = resolvePills(status(), {
      provider: 'some-new-provider',
      modelId: 'mystery-1',
      effort: '',
    });
    expect(pills.modelLabel).toBe('mystery-1');
    expect(pills.provider).toBe('some-new-provider');
  });

  it('takes the model pick and the daemon effort independently', () => {
    const pills = resolvePills(status(), {
      provider: 'claude-code',
      modelId: 'claude-sonnet-5',
      effort: '',
    });
    expect(pills.modelLabel).toBe('Sonnet 5');
    // No effort pick, so the daemon's stands.
    expect(pills.effortId).toBe('high');
    expect(pills.effortLabel).toBe('High');
  });

  it('takes the effort pick and the daemon model independently', () => {
    const pills = resolvePills(status(), {
      provider: '',
      modelId: '',
      effort: 'xhigh',
    });
    expect(pills.modelLabel).toBe('Fable 5');
    expect(pills.effortLabel).toBe('Extra High');
  });

  /** An effort the menu does not carry still labels itself, not the daemon's. */
  it('does not label an unknown effort with the daemon’s', () => {
    const pills = resolvePills(status(), {
      provider: '',
      modelId: '',
      effort: 'ultrabrowse',
    });
    expect(pills.effortId).toBe('ultrabrowse');
    expect(pills.effortLabel).toBe('ultrabrowse');
    expect(pills.effortLabel).not.toBe('High');
  });
});

describe('catalogLabel', () => {
  it('finds a model within its own provider only', () => {
    expect(catalogLabel(CATALOG, 'claude-code', 'claude-fable-5')).toBe('Fable 5');
    // Right model id, wrong provider: not a match.
    expect(catalogLabel(CATALOG, 'openai-codex', 'claude-fable-5')).toBe('');
  });

  it('returns empty for anything it cannot resolve', () => {
    expect(catalogLabel(CATALOG, 'claude-code', 'nope')).toBe('');
    expect(catalogLabel(CATALOG, '', 'claude-fable-5')).toBe('');
    expect(catalogLabel(undefined, 'claude-code', 'claude-fable-5')).toBe('');
  });
});
