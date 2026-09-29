import { useMemo, useState } from 'react';
import { Check, ProviderMark, Search, Settings } from './Icons';
import { AdaptivePickerSurface, PickerGroup, PickerRow } from './AdaptivePickerSurface';
import type { CatalogProvider } from '../types';

export interface ModelSheetProps {
  anchor: HTMLElement | null;
  catalog: CatalogProvider[];
  currentProvider: string;
  currentModel: string;
  onPickModel: (provider: string, modelId: string) => void;
  onOpenSettings?: () => void;
  onClose: () => void;
}

export interface ReasoningSheetProps {
  anchor: HTMLElement | null;
  options: Array<{ id: string; label: string }>;
  current: string;
  unavailableCurrent?: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\bgpt\s+(?=\d)/g, 'gpt-');
}

export function ModelSheet({
  anchor,
  catalog,
  currentProvider,
  currentModel,
  onPickModel,
  onOpenSettings,
  onClose,
}: ModelSheetProps) {
  const [query, setQuery] = useState('');
  const orderedProviders = useMemo(
    () => [...catalog].sort((a, b) => Number(b.id === currentProvider) - Number(a.id === currentProvider)),
    [catalog, currentProvider],
  );
  const q = normalizedQuery(query);
  const groups = useMemo(
    () => orderedProviders
      .map((provider) => ({
        provider,
        models: provider.models.filter((model) =>
          !q || normalizedQuery(`${provider.id} ${provider.label} ${model.label} ${model.id}`).includes(q),
        ),
      }))
      .filter(({ models }) => models.length > 0),
    [orderedProviders, q],
  );

  const choose = (provider: string, modelId: string) => {
    onPickModel(provider, modelId);
    onClose();
  };

  return (
    <AdaptivePickerSurface anchor={anchor} title="Model" onClose={onClose} width={300}>
      <label className="picker-search">
        <Search size={15} aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {groups.map(({ provider, models }) => (
        <PickerGroup key={provider.id} title={provider.label}>
          {models.map((model) => {
            const selected = provider.id === currentProvider && model.id === currentModel;
            return (
              <PickerRow
                key={model.id}
                title={model.label}
                leading={<ProviderMark id={provider.id} size={16} />}
                selected={selected}
                trailing={selected ? <Check size={15} /> : null}
                onClick={() => choose(provider.id, model.id)}
              />
            );
          })}
        </PickerGroup>
      ))}

      {groups.length === 0 ? <p className="picker-empty">{q ? 'No matching models' : 'No models configured'}</p> : null}

      {onOpenSettings && !q ? (
        <PickerGroup className="picker-actions">
          <PickerRow
            title="Settings"
            leading={<Settings size={16} />}
            selection={false}
            onClick={onOpenSettings}
          />
        </PickerGroup>
      ) : null}
    </AdaptivePickerSurface>
  );
}

/** Aside calls this selector Effort; the bridge still uses the CLI's effort contract. */
export function ReasoningSheet({
  anchor,
  options,
  current,
  unavailableCurrent = false,
  onPick,
  onClose,
}: ReasoningSheetProps) {
  return (
    <AdaptivePickerSurface anchor={anchor} title="Effort" onClose={onClose} width={220}>
      {unavailableCurrent ? (
        <p className="picker-note">This effort is not verified for the selected model. Choose a supported effort before sending.</p>
      ) : null}
      <PickerGroup>
        {options.map((option) => {
          const selected = option.id === current;
          return (
            <PickerRow
              key={option.id}
              title={option.label}
              subtitle={option.id === 'ultrabrowse' ? 'Availability must be checked in Aside.' : undefined}
              className={option.id === 'ultrabrowse' ? 'is-ultrabrowse' : ''}
              disabled={option.id === 'ultrabrowse'}
              selected={selected}
              trailing={selected ? <Check size={15} /> : null}
              onClick={() => {
                onPick(option.id);
                onClose();
              }}
            />
          );
        })}
      </PickerGroup>
    </AdaptivePickerSurface>
  );
}
