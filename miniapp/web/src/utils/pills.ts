/**
 * What the model and effort pills should read.
 *
 * The precedence is the whole of it: an explicit local pick wins, and
 * otherwise the pills mirror the DAEMON's own account default (from
 * `/api/status`, which reads `aside.settings.getAll().defaultModel`) rather
 * than anything from the bridge config. A user who has never chosen should
 * see what the browser would use.
 *
 * Extracted from App so it can be tested directly. It also had a real bug
 * that only a direct test would have caught: the label started at the
 * daemon default's label and was only overwritten when the picked model was
 * found in the catalog -- so an explicit pick of a model the catalog does
 * not list displayed the DAEMON's model name while actually running the
 * picked one. The pill has to name the model that will run, or it is worse
 * than no pill.
 */
import type { CatalogProvider, StatusResponse } from '../types';

export interface PillState {
  provider: string;
  modelId: string;
  modelLabel: string;
  effortId: string;
  effortLabel: string;
}

export interface LocalPick {
  provider: string;
  modelId: string;
  effort: string;
}

/** The catalog's display name for a model, or '' when it lists no such one. */
export function catalogLabel(
  catalog: CatalogProvider[] | undefined,
  provider: string,
  modelId: string,
): string {
  if (!catalog || !provider || !modelId) return '';
  for (const entry of catalog) {
    if (entry.id !== provider) continue;
    const found = entry.models.find((m) => m.id === modelId);
    if (found) return found.label;
  }
  return '';
}

export function resolvePills(
  status: StatusResponse | null,
  pick: LocalPick,
): PillState {
  const defaults = status?.defaults;

  const hasModelPick = Boolean(pick.modelId);
  const provider = pick.provider || defaults?.provider || '';
  const modelId = pick.modelId || defaults?.modelId || '';

  // With a pick, the label must describe the PICKED model: the catalog's
  // name for it, else its bare id. Falling back to the daemon's label here
  // is what made the pill lie.
  const modelLabel = hasModelPick
    ? catalogLabel(status?.catalog, provider, modelId) || modelId || 'Model'
    : catalogLabel(status?.catalog, provider, modelId) ||
      defaults?.modelLabel ||
      modelId ||
      'Model';

  const effortId = pick.effort || defaults?.effort || 'high';
  const effortLabel =
    status?.effortMenu?.find((e) => e.id === effortId)?.label ||
    (pick.effort ? '' : defaults?.effortLabel) ||
    effortId;

  return { provider, modelId, modelLabel, effortId, effortLabel };
}
