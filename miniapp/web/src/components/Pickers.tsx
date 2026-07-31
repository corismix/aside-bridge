/**
 * The Reasoning and model pickers, matching Aside's own popovers.
 *
 * Reasoning: a titled list -- Low, Medium, High, Extra High, Ultrabrowse --
 * with a checkmark on the current level and Ultrabrowse in rainbow text.
 * "Max" is in Aside's desktop menu but not here: `aside exec` rejects it
 * outright (`--effort` allows off/minimal/low/medium/high/xhigh/
 * ultrabrowse), and silently sending something else under the name "Max"
 * would misreport what the turn ran at.
 *
 * Models: a searchable provider list; tapping a provider opens its models.
 * The search field flattens across every provider, as Aside's does.
 */
import { useMemo, useState } from 'react';
import { Popover, PopoverRow, PopoverTitle } from './Popover';
import {
  Check,
  ChevronRight,
  ChevronLeft,
  ArrowUpRight,
  PermissionGlyph,
  ProviderMark,
  Search,
  Settings,
} from './Icons';
import type { CatalogProvider } from '../types';

export interface PermissionPickerProps {
  anchor: HTMLElement | null;
  options: Array<{ id: string; label: string }>;
  /** The daemon's current mode; null when it could not be read. */
  current: string | null;
  /** The confirm-before-acting switch's state; null when unreadable. */
  finalConfirm: boolean | null;
  /**
   * True when the switch means the SOFT protocol rather than the daemon's
   * `runtimeConfig.finalConfirm` -- which is the case on every session
   * driven from a phone. The copy changes with it, because a switch that
   * describes itself wrongly is worse than no switch.
   */
  softConfirm?: boolean;
  onPickMode: (id: string) => void;
  onToggleConfirm: (next: boolean) => void;
  onClose: () => void;
}

/**
 * Aside's Permission popover.
 *
 * Three modes with a checkmark on the live one, then a divider and the
 * confirm-before-acting switch. The mode rows close the popover on pick
 * (they are a choice); the switch does not (it is a toggle you may want to
 * see settle).
 *
 * The switch is deliberately NOT labelled "Final confirm" any more. That
 * name belonged to the daemon's `runtimeConfig.finalConfirm`, which makes
 * the agent call `request_action_confirmation` -- a prompt only Aside on
 * the desktop can answer, so turning it on from a phone guaranteed a dead
 * session the first time the agent touched anything external. On a mobile
 * session it now drives the soft confirm protocol instead, and the label
 * says what it actually does.
 *
 * The footnote is not decoration. The setting is read when the next
 * `aside exec` is spawned, so a change binds from the next message and does
 * not reach into a turn already running. Saying so is cheaper than having
 * the owner discover it.
 */
export function PermissionPicker({
  anchor,
  options,
  current,
  finalConfirm,
  softConfirm,
  onPickMode,
  onToggleConfirm,
  onClose,
}: PermissionPickerProps) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={224}>
      <PopoverTitle>Permission</PopoverTitle>
      {options.map((option) => (
        <PopoverRow
          key={option.id}
          selected={option.id === current}
          leading={<PermissionGlyph mode={option.id} />}
          trailing={option.id === current ? <Check size={14} /> : null}
          onClick={() => {
            onPickMode(option.id);
            onClose();
          }}
        >
          {option.label}
        </PopoverRow>
      ))}

      <div className="popover-sep" />

      <div className="popover-switch-row">
        <span className="popover-row-label">Confirm before acting</span>
        <button
          type="button"
          role="switch"
          aria-checked={finalConfirm === true}
          aria-label="Confirm before acting"
          className={`switch ${finalConfirm ? 'is-on' : ''}`}
          onClick={() => onToggleConfirm(!finalConfirm)}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <p className="popover-note">
        {softConfirm === false
          ? 'Applies from your next message.'
          : 'Asks here, on a card you can answer. Applies from your next message.'}
      </p>
    </Popover>
  );
}

export interface EffortPickerProps {
  anchor: HTMLElement | null;
  options: Array<{ id: string; label: string }>;
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

export function EffortPicker({
  anchor,
  options,
  current,
  onPick,
  onClose,
}: EffortPickerProps) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={208}>
      <PopoverTitle>Reasoning</PopoverTitle>
      {options.map((option) => (
        <PopoverRow
          key={option.id}
          selected={option.id === current}
          className={option.id === 'ultrabrowse' ? 'is-ultrabrowse' : ''}
          trailing={option.id === current ? <Check size={14} /> : null}
          onClick={() => {
            onPick(option.id);
            onClose();
          }}
        >
          {option.label}
        </PopoverRow>
      ))}
    </Popover>
  );
}

export interface ModelPickerProps {
  anchor: HTMLElement | null;
  catalog: CatalogProvider[];
  currentProvider: string;
  currentModel: string;
  onPick: (provider: string, modelId: string) => void;
  onClose: () => void;
  /**
   * Open the Settings screen.
   *
   * The Settings row used to close the popover and nothing else -- it was a
   * control that did not work. It now goes somewhere.
   */
  onOpenSettings?: () => void;
}

export function ModelPicker({
  anchor,
  catalog,
  currentProvider,
  currentModel,
  onPick,
  onClose,
  onOpenSettings,
}: ModelPickerProps) {
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // A search collapses the two-level menu into one flat list of matches --
  // otherwise you would have to already know which provider owns a model.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out: Array<{ provider: CatalogProvider; modelId: string; label: string }> = [];
    for (const provider of catalog) {
      for (const model of provider.models) {
        const hay = `${provider.label} ${model.label} ${model.id}`.toLowerCase();
        if (hay.includes(q)) {
          out.push({ provider, modelId: model.id, label: model.label });
        }
      }
    }
    return out;
  }, [catalog, query]);

  const drilled = openProvider
    ? catalog.find((p) => p.id === openProvider) || null
    : null;

  const choose = (provider: string, modelId: string) => {
    onPick(provider, modelId);
    onClose();
  };

  if (drilled) {
    return (
      <Popover anchor={anchor} onClose={onClose} width={244}>
        <PopoverRow
          leading={<ChevronLeft size={14} />}
          onClick={() => setOpenProvider(null)}
        >
          {drilled.label}
        </PopoverRow>
        <div className="popover-sep" />
        {drilled.models.map((model) => (
          <PopoverRow
            key={model.id}
            selected={
              drilled.id === currentProvider && model.id === currentModel
            }
            trailing={
              drilled.id === currentProvider && model.id === currentModel ? (
                <Check size={14} />
              ) : null
            }
            onClick={() => choose(drilled.id, model.id)}
          >
            {model.label}
          </PopoverRow>
        ))}
        {drilled.models.length === 0 ? (
          <div className="popover-empty">No models configured</div>
        ) : null}
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} onClose={onClose} width={244}>
      <label className="popover-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {matches ? (
        <>
          {matches.map((match) => (
            <PopoverRow
              key={`${match.provider.id}/${match.modelId}`}
              selected={
                match.provider.id === currentProvider &&
                match.modelId === currentModel
              }
              leading={<ProviderMark id={match.provider.id} size={14} />}
              trailing={
                match.provider.id === currentProvider &&
                match.modelId === currentModel ? (
                  <Check size={14} />
                ) : null
              }
              onClick={() => choose(match.provider.id, match.modelId)}
            >
              {match.label}
            </PopoverRow>
          ))}
          {matches.length === 0 ? (
            <div className="popover-empty">No matches</div>
          ) : null}
        </>
      ) : (
        <>
          {catalog.map((provider) => (
            <PopoverRow
              key={provider.id}
              leading={<ProviderMark id={provider.id} />}
              trailing={<ChevronRight size={14} />}
              selected={provider.id === currentProvider}
              onClick={() => setOpenProvider(provider.id)}
            >
              {provider.label}
            </PopoverRow>
          ))}
          <div className="popover-sep" />
          <PopoverRow
            trailing={<ArrowUpRight size={14} />}
            onClick={onOpenSettings ?? onClose}
          >
            <span className="popover-muted">
              <Settings size={13} /> Settings
            </span>
          </PopoverRow>
        </>
      )}
    </Popover>
  );
}
