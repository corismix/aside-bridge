/**
 * Live mirror of the desktop app's own provider catalog.
 *
 * The mini app used to carry a hand-written copy of the model list inside
 * the bridge config, and that copy drifted badly: by 2026-08-02 it listed
 * six 9router models that no longer existed (`claude-fable-5`,
 * `oc/deepseek-v4-flash-free(max)`, `cf/@cf/moonshotai/kimi-k2.6`,
 * `nvidia/deepseek-ai/deepseek-v4-pro`, `nvidia/z-ai/glm-5.2`,
 * `oc/nemotron-3-ultra-free`), was missing four that did (`glm5.2`,
 * `nemo`, `gc/gemini-2.5-pro`, `ocx/google-antigravity/claude-sonnet-4-6`),
 * showed one of OCX's seven, and pinned `claude-code` to
 * `connected: false, models: []` while the desktop's own default model was
 * `claude-code/claude-opus-5`. The phone could not select the model the
 * computer was actually running.
 *
 * Copying the list again would only reset that clock. Instead this reads
 * the files the desktop app itself writes:
 *
 *   <account>/models.json    custom providers and first-party account catalogs
 *   <account>/cache/models-catalog.json
 *                            provider model records and visible model ids
 *   <account>/cache/aside-models-catalog.json
 *                            the hosted Aside model catalog and visibility
 *   <account>/settings.json  default/category bindings and Aside visibility
 *
 * where <account> is whichever account the desktop is signed in to, not
 * a hardcoded u/0 -- see `defaultAsideRoot`.
 *
 * All of these files are read-only here. The desktop owns them; drift is impossible by
 * construction because there is no second copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultAsideRoot } from './config.js';

/** A model as the desktop app defines it. */
export interface DesktopModel {
  id: string;
  label: string;
  contextWindow: number;
  /** True when the model accepts images as well as text. */
  vision: boolean;
}

/** A provider as the desktop app defines it. */
export interface DesktopProvider {
  id: string;
  label: string;
  models: DesktopModel[];
  /** Cached provider inventories still require a matching credential. */
  requiresCredentials?: boolean;
}

/** A `provider/modelId` binding, as `defaultModel` and the categories use. */
export interface DesktopModelRef {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface DesktopState {
  providers: DesktopProvider[];
  defaultModel: DesktopModelRef | null;
  /** fast / standard / deep / visual, as bound in the desktop settings. */
  categories: Record<string, DesktopModelRef>;
  customModels: DesktopProvider[];
}

export interface AsideModelCatalogSettings {
  added: string[];
  removed: string[];
}

export const EMPTY_DESKTOP: DesktopState = {
  providers: [],
  defaultModel: null,
  categories: {},
  customModels: [],
};

/**
 * The account root the desktop app keeps its state under.
 *
 * Derived from `sessionsDir` (which the bridge config already carries and
 * which is always `<root>/sessions`) so there is nothing new to configure,
 * with the conventional path as a fallback and an env override for tests.
 */
export function desktopRoot(sessionsDir: string): string {
  const explicit = process.env.MINIAPP_ASIDE_ROOT;
  if (explicit) return explicit;
  if (sessionsDir && path.basename(sessionsDir) === 'sessions') {
    return path.dirname(sessionsDir);
  }
  // Not a hardcoded u/0 any more: resolve whichever account is current.
  return defaultAsideRoot();
}

export function modelsPath(root: string): string {
  return path.join(root, 'models.json');
}

export function modelsCatalogPath(root: string): string {
  return path.join(root, 'cache', 'models-catalog.json');
}

export function desktopSettingsPath(root: string): string {
  return path.join(root, 'settings.json');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing or half-written file: the caller falls back to built-ins
    // rather than showing an empty picker.
    return null;
  }
}

/** What `models.json` records for one model, coerced and defaulted. */
function toModel(raw: unknown): DesktopModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? '').trim();
  if (!id) return null;
  const input = Array.isArray(record.input) ? record.input.map(String) : [];
  const contextWindow = Number(record.contextWindow);
  return {
    id,
    label: String(record.name || record.label || id).trim() || id,
    contextWindow: contextWindow > 0 ? contextWindow : 200_000,
    vision: input.includes('image'),
  };
}

/**
 * The account-backed providers in `models.json` store their live model set as
 * ids rather than full model records. Keep this reader deliberately narrow:
 * ids are all the Mini App needs to make a model selectable, and no provider
 * credential or transport field is copied across the boundary.
 */
function toAccountCatalogModels(raw: unknown): DesktopModel[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const modelIds = (raw as Record<string, unknown>).modelIds;
  if (!Array.isArray(modelIds)) return null;

  const models: DesktopModel[] = [];
  const seen = new Set<string>();
  for (const value of modelIds) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      // Account catalogs currently expose ids only. The catalog layer keeps
      // a known built-in label where one exists and otherwise shows this id.
      label: id,
      contextWindow: 200_000,
      vision: false,
    });
  }
  return models;
}

function stringIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function visibleModelIds(raw: unknown): string[] | null {
  // An empty array is meaningful: the desktop intentionally hides every
  // model for that provider. Mixed or non-string data is malformed, so let
  // the caller use its normal fallback instead.
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    return null;
  }
  return stringIds(raw) ?? [];
}

/**
 * A cached provider catalog is the same safe subset the desktop's
 * `models.listSettingsInventory` query turns into `availableModels`.
 * `visibleModelIds` is important: the cache also retains models that are
 * known to the provider but that the desktop currently hides.
 */
function toCachedProvider(
  id: string,
  raw: unknown,
  asideVisibility: AsideModelCatalogSettings,
): DesktopProvider | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const allModels = Array.isArray(record.models)
    ? record.models.map(toModel).filter((m): m is DesktopModel => m !== null)
    : [];
  if (!allModels.length) return null;

  const visibleIds = visibleModelIds(record.visibleModelIds);
  let models = visibleIds
    ? allModels.filter((model) => visibleIds.includes(model.id))
    : allModels;

  if (id === 'aside') {
    const byId = new Map(allModels.map((model) => [model.id, model]));
    const selected = new Set(models.map((model) => model.id));
    for (const modelId of asideVisibility.added) {
      const model = byId.get(modelId);
      if (model) selected.add(model.id);
    }
    for (const modelId of asideVisibility.removed) selected.delete(modelId);
    models = allModels.filter((model) => selected.has(model.id));
  }

  return { id, label: id, models, requiresCredentials: id !== 'aside' };
}

function readCachedProviders(
  file: string,
  asideFile: string,
  asideVisibility: AsideModelCatalogSettings,
): DesktopProvider[] {
  const out: DesktopProvider[] = [];
  const parsed = readJson(file);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const provider = toCachedProvider(id, value, asideVisibility);
      if (provider) out.push(provider);
    }
  }

  const aside = readJson(asideFile);
  if (aside && typeof aside === 'object' && !Array.isArray(aside)) {
    const catalog = (aside as Record<string, unknown>).catalog;
    const provider = toCachedProvider('aside', catalog, asideVisibility);
    if (provider) out.push(provider);
  }
  return out;
}

/** Custom model records stored in settings.json, grouped by provider. */
function toCustomModelProviders(raw: unknown): DesktopProvider[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, DesktopProvider>();
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const id = String(record.provider ?? '').trim();
    const model = toModel(value);
    if (!id || !model) continue;
    const provider = byId.get(id) ?? {
      id,
      label: id,
      models: [],
    };
    if (!provider.models.some((existing) => existing.id === model.id)) {
      provider.models.push(model);
    }
    byId.set(id, provider);
  }
  return [...byId.values()];
}

/**
 * Providers from the desktop account catalog files.
 *
 * Custom providers are local gateways keyed by a baseUrl rather than by an
 * entry in credentials.json. First-party/account-backed providers instead
 * persist their current model ids in `accountModelCatalog.modelIds`. Both
 * forms are authoritative when present, which is why the old credentials-only
 * seeding missed models the desktop could use.
 *
 * `apiKey` and `baseUrl` are deliberately not returned: nothing downstream
 * needs them and they must not reach the phone.
 */
export function readDesktopProviders(
  file: string,
  catalogFile = modelsCatalogPath(path.dirname(file)),
  asideCatalogSettings: AsideModelCatalogSettings = { added: [], removed: [] },
  customModels: DesktopProvider[] = [],
): DesktopProvider[] {
  const parsed = readJson(file) as { providers?: Record<string, unknown> } | null;
  const providers = parsed?.providers;
  const byId = new Map<string, DesktopProvider>();
  if (providers && typeof providers === 'object') {
    for (const [id, value] of Object.entries(providers)) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const accountModels = toAccountCatalogModels(record.accountModelCatalog);
      const models = accountModels ?? (Array.isArray(record.models)
        ? record.models.map(toModel).filter((m): m is DesktopModel => m !== null)
        : []);
      if (!models.length) continue;
      byId.set(id, {
        id,
        label: String(record.name || id).trim() || id,
        models,
        requiresCredentials: Boolean(record.accountModelCatalog),
      });
    }
  }

  // Aside writes this cache for the same inventory query the desktop model
  // picker uses. Prefer it over models.json for providers it describes, but
  // leave custom/local providers from models.json untouched when no cache
  // entry exists for them.
  for (const provider of readCachedProviders(
    catalogFile,
    path.join(path.dirname(catalogFile), 'aside-models-catalog.json'),
    asideCatalogSettings,
  )) {
    byId.set(provider.id, provider);
  }
  for (const provider of customModels) {
    const existing = byId.get(provider.id);
    if (!existing) {
      byId.set(provider.id, provider);
      continue;
    }
    const models = new Map(existing.models.map((model) => [model.id, model]));
    for (const model of provider.models) models.set(model.id, model);
    existing.models = [...models.values()];
  }
  return [...byId.values()];
}

function toRef(raw: unknown): DesktopModelRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const provider = String(record.provider ?? '').trim();
  const modelId = String(record.modelId ?? '').trim();
  if (!provider || !modelId) return null;
  return {
    provider,
    modelId,
    thinkingLevel: String(record.thinkingLevel ?? '').trim(),
  };
}

/** `defaultModel` and `modelCategories` out of the desktop settings file. */
export function readDesktopSettings(file: string): {
  defaultModel: DesktopModelRef | null;
  categories: Record<string, DesktopModelRef>;
  asideModelCatalog: AsideModelCatalogSettings;
  customModels: DesktopProvider[];
} {
  const parsed = readJson(file) as Record<string, unknown> | null;
  if (!parsed) {
    return {
      defaultModel: null,
      categories: {},
      asideModelCatalog: { added: [], removed: [] },
      customModels: [],
    };
  }

  const categories: Record<string, DesktopModelRef> = {};
  const rawCategories = parsed.modelCategories;
  if (rawCategories && typeof rawCategories === 'object') {
    for (const [name, value] of Object.entries(
      rawCategories as Record<string, unknown>,
    )) {
      const ref = toRef(value);
      if (ref) categories[name] = ref;
    }
  }

  const rawAsideCatalog = parsed.asideModelCatalog;
  const asideModelCatalog = rawAsideCatalog && typeof rawAsideCatalog === 'object'
    ? {
        added: stringIds((rawAsideCatalog as Record<string, unknown>).added) ?? [],
        removed: stringIds((rawAsideCatalog as Record<string, unknown>).removed) ?? [],
      }
    : { added: [], removed: [] };

  return {
    defaultModel: toRef(parsed.defaultModel),
    categories,
    asideModelCatalog,
    customModels: toCustomModelProviders(parsed.customModels),
  };
}

/**
 * Read everything the catalog needs from the desktop, in one shot.
 *
 * Cheap enough to call per request (a few small JSON files, page-cached by
 * the OS) and doing so is the point: editing a model in the desktop app
 * must show up on the phone without restarting anything.
 */
export function readDesktopState(sessionsDir: string): DesktopState {
  const root = desktopRoot(sessionsDir);
  const { defaultModel, categories, asideModelCatalog, customModels } = readDesktopSettings(
    desktopSettingsPath(root),
  );
  return {
    providers: readDesktopProviders(
      modelsPath(root),
      modelsCatalogPath(root),
      asideModelCatalog,
      customModels,
    ),
    defaultModel,
    categories,
    customModels,
  };
}
