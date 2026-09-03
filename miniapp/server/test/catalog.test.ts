import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  buildCatalog,
  modelLabel,
  readProviderIds,
} from '../src/catalog.js';
import { readDesktopProviders, readDesktopSettings } from '../src/desktop.js';

const temps: string[] = [];

function writeCredentials(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-cred-'));
  temps.push(dir);
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, body);
  return file;
}

function writeModels(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-models-'));
  temps.push(dir);
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, body);
  return file;
}

function writeModelCache(modelsFile: string, body: string, name = 'models-catalog.json'): void {
  const cache = path.join(path.dirname(modelsFile), 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, name), body);
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('credential seeding', () => {
  it('reads only the top-level keys', () => {
    const file = writeCredentials(
      JSON.stringify({
        'claude-code': { access_token: 'SECRET-A', refresh: 'SECRET-B' },
        'openai-codex': { api_key: 'SECRET-C' },
      }),
    );
    expect(readProviderIds(file)).toEqual(['claude-code', 'openai-codex']);
  });

  it('treats a missing or malformed file as "no information"', () => {
    expect(readProviderIds('/nope/credentials.json')).toEqual([]);
    expect(readProviderIds(writeCredentials('not json'))).toEqual([]);
    expect(readProviderIds(writeCredentials('[1,2]'))).toEqual([]);
  });
});

describe('buildCatalog', () => {
  it('marks credentialed providers connected and sorts them first', () => {
    const catalog = buildCatalog(['xai-grok-oauth']);
    expect(catalog.find((p) => p.id === 'xai-grok-oauth')?.connected).toBe(true);
    // Aside's own gateway needs no credentials.json entry.
    expect(catalog.find((p) => p.id === 'aside')?.connected).toBe(true);
    // An uncredentialed provider is OMITTED, matching Aside's picker:
    // listing Claude without credentials would claim the account can
    // run it.
    expect(catalog.find((p) => p.id === 'claude-code')).toBeUndefined();
  });

  it('uses Aside display names and model ids', () => {
    const catalog = buildCatalog(['claude-code', 'openai-codex']);
    const claude = catalog.find((p) => p.id === 'claude-code')!;
    const chatgpt = catalog.find((p) => p.id === 'openai-codex')!;

    expect(claude.label).toBe('Claude');
    expect(claude.models.map((m) => m.label)).toContain('Fable 5');
    expect(claude.models.find((m) => m.label === 'Fable 5')?.id).toBe(
      'claude-fable-5',
    );

    expect(chatgpt.label).toBe('ChatGPT');
    // Mirrors the account's accountModelCatalog.
    expect(chatgpt.models.map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('uses the first-party account catalog instead of the stale built-in list', () => {
    const file = writeModels(
      JSON.stringify({
        providers: {
          'openai-codex': {
            accountModelCatalog: {
              credentialFingerprint: 'SECRET-FINGERPRINT',
              modelIds: ['gpt-reserve', 'gpt-5.6-luna', 'codex-auto-review'],
            },
          },
        },
      }),
    );
    const desktop = readDesktopProviders(file);
    const catalog = buildCatalog(['openai-codex'], {}, desktop, []);
    const chatgpt = catalog.find((p) => p.id === 'openai-codex')!;

    expect(chatgpt.models.map((m) => m.id)).toEqual([
      'gpt-reserve',
      'gpt-5.6-luna',
      'codex-auto-review',
    ]);
    expect(chatgpt.label).toBe('ChatGPT');
    expect(JSON.stringify(desktop)).not.toContain('SECRET-FINGERPRINT');
  });

  it('falls back to built-ins when the account catalog has no usable ids', () => {
    const file = writeModels(
      JSON.stringify({
        providers: {
          'openai-codex': { accountModelCatalog: { modelIds: [null, 42] } },
        },
      }),
    );
    const catalog = buildCatalog(
      ['openai-codex'],
      {},
      readDesktopProviders(file),
      [],
    );
    const chatgpt = catalog.find((p) => p.id === 'openai-codex')!;

    expect(chatgpt.models.map((m) => m.id)).toContain('gpt-5.6-sol');
  });

  it('uses Aside’s visible provider cache instead of a second model catalog', () => {
    const file = writeModels(JSON.stringify({ providers: {} }));
    writeModelCache(
      file,
      JSON.stringify({
        'opencode-go': {
          visibleModelIds: ['hy4-preview'],
          models: [
            {
              id: 'hy4-preview',
              name: 'Hy4 preview',
              contextWindow: 1024000,
              input: ['text'],
              baseUrl: 'https://secret.example.invalid/v1',
            },
            { id: 'hidden-model', name: 'Hidden model' },
          ],
        },
        anthropic: {
          visibleModelIds: ['not-connected'],
          models: [{ id: 'not-connected', name: 'Not connected' }],
        },
      }),
    );

    const desktop = readDesktopProviders(file);
    const catalog = buildCatalog(['opencode-go'], {}, desktop, []);
    const provider = catalog.find((p) => p.id === 'opencode-go')!;

    expect(provider.label).toBe('OpenCode Go');
    expect(provider.models).toEqual([
      { id: 'hy4-preview', label: 'Hy4 preview', contextWindow: 1024000 },
    ]);
    expect(catalog.find((candidate) => candidate.id === 'anthropic')).toBeUndefined();
    expect(JSON.stringify(desktop)).not.toContain('secret.example.invalid');
  });

  it('does not resurrect models when Aside explicitly hides the whole provider', () => {
    const file = writeModels(JSON.stringify({ providers: {} }));
    writeModelCache(
      file,
      JSON.stringify({
        'openai-codex': {
          visibleModelIds: [],
          models: [{ id: 'hidden-by-account', name: 'Hidden by account' }],
        },
      }),
    );

    const catalog = buildCatalog(
      ['openai-codex'],
      {},
      readDesktopProviders(file),
      [],
    );

    expect(catalog.find((provider) => provider.id === 'openai-codex')?.models).toEqual([]);
  });

  it('applies Aside model visibility settings to the hosted cache', () => {
    const file = writeModels(JSON.stringify({ providers: {} }));
    writeModelCache(
      file,
      JSON.stringify({
        catalog: {
          visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
            { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
          ],
        },
      }),
      'aside-models-catalog.json',
    );
    const settings = writeModels(
      JSON.stringify({
        asideModelCatalog: {
          added: ['gpt-5.6-luna'],
          removed: ['gpt-5.6-terra'],
        },
      }),
    );

    const { asideModelCatalog } = readDesktopSettings(settings);
    const provider = readDesktopProviders(
      file,
      path.join(path.dirname(file), 'cache', 'models-catalog.json'),
      asideModelCatalog,
    )
      .find((p) => p.id === 'aside')!;

    expect(provider.models.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
    ]);
  });

  it('keeps settings-backed custom models selectable without leaking transport fields', () => {
    const modelsFile = writeModels(JSON.stringify({ providers: {} }));
    const settingsFile = writeModels(
      JSON.stringify({
        customModels: [
          {
            provider: 'custom-gateway',
            id: 'local-model',
            name: 'Local Model',
            baseUrl: 'https://secret.example.invalid/v1',
          },
        ],
      }),
    );
    const { customModels } = readDesktopSettings(settingsFile);
    const desktop = readDesktopProviders(
      modelsFile,
      path.join(path.dirname(modelsFile), 'cache', 'models-catalog.json'),
      { added: [], removed: [] },
      customModels,
    );
    const catalog = buildCatalog([], {}, desktop, []);

    expect(catalog.find((provider) => provider.id === 'custom-gateway')?.models).toEqual([
      { id: 'local-model', label: 'Local Model', contextWindow: DEFAULT_CONTEXT_WINDOW },
    ]);
    expect(JSON.stringify(desktop)).not.toContain('secret.example.invalid');
  });

  it('shows the Aside gateway with display names', () => {
    const catalog = buildCatalog(['openai-codex']);
    const aside = catalog.find((p) => p.id === 'aside')!;
    expect(aside.label).toBe('Aside');
    expect(aside.connected).toBe(true);
    expect(aside.models.map((m) => m.label)).toContain('GPT-5.6 Luna');
  });

  it('shows every built-in provider when credentials cannot be read', () => {
    const catalog = buildCatalog([]);
    expect(catalog.length).toBeGreaterThanOrEqual(3);
    expect(catalog.every((p) => p.connected)).toBe(true);
  });

  it('gives an unknown credentialed provider its own row', () => {
    const catalog = buildCatalog(['some-new-provider']);
    const row = catalog.find((p) => p.id === 'some-new-provider');
    expect(row).toBeDefined();
    expect(row?.connected).toBe(true);
  });

  it('merges config overrides over the built-in table', () => {
    const catalog = buildCatalog(['claude-code'], {
      'claude-code': { models: [{ id: 'claude-fable-6', label: 'Fable 6' }] },
    });
    const claude = catalog.find((p) => p.id === 'claude-code')!;
    // Merge keeps the built-ins and adds the new one.
    expect(claude.models.map((m) => m.id)).toContain('claude-fable-5');
    expect(claude.models.map((m) => m.id)).toContain('claude-fable-6');
  });

  it('replaces a provider list when asked, and can rename it', () => {
    const catalog = buildCatalog(['claude-code'], {
      'claude-code': {
        label: 'Anthropic',
        replace: true,
        models: [{ id: 'only-one', label: 'Only One' }],
      },
    });
    const claude = catalog.find((p) => p.id === 'claude-code')!;
    expect(claude.label).toBe('Anthropic');
    expect(claude.models).toEqual([
      { id: 'only-one', label: 'Only One', contextWindow: DEFAULT_CONTEXT_WINDOW },
    ]);
  });

  it('can add a provider that has no built-in entry', () => {
    const catalog = buildCatalog([], {
      'my-local': {
        label: 'Local',
        connected: true,
        models: [{ id: 'llama', label: 'Llama' }],
      },
    });
    expect(catalog.find((p) => p.id === 'my-local')?.label).toBe('Local');
  });
});

describe('the opencode seed', () => {
  // MuseSpark via OpenCode Zen used to surface as a bare credential id
  // with a raw model id, the one provider Aside's own chat names properly.
  const catalog = buildCatalog(['opencode']);
  const provider = catalog.find((p) => p.id === 'opencode');

  it('shows the OpenCode display name', () => {
    expect(provider?.label).toBe('OpenCode');
    expect(provider?.connected).toBe(true);
  });

  it('names Muse Spark the way Aside does', () => {
    expect(modelLabel(catalog, 'opencode', 'muse-spark-1.3-contributor-free')).toBe(
      'Muse Spark 1.3 Free',
    );
  });
});

describe('modelLabel', () => {
  const catalog = buildCatalog(['claude-code']);

  it('resolves a display name for the pill', () => {
    expect(modelLabel(catalog, 'claude-code', 'claude-fable-5')).toBe('Fable 5');
  });

  it('falls back to the raw id rather than hiding an unknown model', () => {
    expect(modelLabel(catalog, 'claude-code', 'claude-future-9')).toBe(
      'claude-future-9',
    );
  });
});
