/**
 * Settings.
 *
 * The Settings row in the model picker used to close the popover and do
 * nothing at all. This is the screen it should have opened.
 *
 * Structure follows Aside's own settings pages (`settings-*.js`,
 * `use-agent-settings-*.js`, `ai-*.js`): sections with a small uppercase
 * heading, rows carrying a title and a description on the left and the
 * control on the right, hairline dividers between them, and a footnote
 * where a setting's scope needs stating.
 *
 * Scope, stated once here and enforced on the server: everything writable
 * on this screen is a default for sessions THIS APP creates, stored in the
 * mini app's own file. Nothing here writes Aside's account-wide settings --
 * a default changed from a phone must not silently retarget the sessions
 * the owner starts on their computer. Aside's own values are shown, and
 * shown as read-only.
 */
import { useEffect, useState } from 'react';
import { AsideSymbol, Check, ChevronLeft, ProviderMark, Spinner } from './Icons';
import { api } from '../api';
import {
  haptic,
  inTelegram,
  setThemePreference,
  themePreference,
  type ThemePreference,
} from '../telegram';
import { disablePush, enablePush, pushEnabled, pushSupported } from '../push';
import type { MiniappSettings, StatusResponse } from '../types';

function Section({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <section className="settings-section">
      <h2 className="settings-heading">{title}</h2>
      <div className="settings-rows">{children}</div>
      {note ? <p className="settings-note">{note}</p> : null}
    </section>
  );
}

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {description ? (
          <span className="settings-row-description">{description}</span>
        ) : null}
      </span>
      <span className="settings-row-control">{control}</span>
    </div>
  );
}

/** A row that expands into a list of choices, with a tick on the live one. */
function ChoiceRow({
  title,
  description,
  value,
  options,
  onPick,
}: {
  title: string;
  description?: string;
  value: string;
  options: Array<{ id: string; label: string; leading?: React.ReactNode }>;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.id === value);

  return (
    <>
      <button
        type="button"
        className="settings-row is-button"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((prev) => !prev);
        }}
      >
        <span className="settings-row-text">
          <span className="settings-row-title">{title}</span>
          {description ? (
            <span className="settings-row-description">{description}</span>
          ) : null}
        </span>
        <span className="settings-row-value">
          {current?.leading}
          {current?.label ?? 'Aside’s default'}
        </span>
      </button>
      {open ? (
        <div className="settings-choices">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`settings-choice ${option.id === value ? 'is-current' : ''}`}
              onClick={() => {
                haptic('light');
                onPick(option.id);
                setOpen(false);
              }}
            >
              {option.leading}
              <span className="settings-choice-label">{option.label}</span>
              {option.id === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => {
        haptic('light');
        onChange(!checked);
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function SettingsScreen({
  status,
  onClose,
  onLogout,
}: {
  status: StatusResponse | null;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [settings, setSettings] = useState<MiniappSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => themePreference());

  useEffect(() => {
    let alive = true;
    api.settings().then(
      (res) => alive && setSettings(res.settings),
      (err) => alive && setError((err as Error).message),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (inTelegram() || !pushSupported()) return;
    void pushEnabled().then(setPushOn).catch(() => {});
  }, []);

  const togglePush = async (next: boolean) => {
    setPushBusy(true);
    setPushError(null);
    try {
      if (next) await enablePush();
      else await disablePush();
      setPushOn(next);
    } catch (err) {
      setPushError((err as Error).message);
    } finally {
      setPushBusy(false);
    }
  };

  /**
   * Optimistic, then corrected by what the server stored.
   *
   * The same shape the permission control already uses: the row moves on
   * tap, and a failed write puts the server's truth back rather than
   * leaving a claim on screen we cannot stand behind.
   */
  const save = (patch: Partial<MiniappSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    api.saveSettings(patch).then(
      (res) => setSettings(res.settings),
      () => {
        api.settings().then(
          (res) => setSettings(res.settings),
          () => {},
        );
      },
    );
  };

  const modelOptions = [
    { id: '', label: 'Aside’s default' },
    ...(status?.catalog ?? []).flatMap((provider) =>
      provider.models.map((model) => ({
        id: `${provider.id}/${model.id}`,
        label: `${provider.label} · ${model.label}`,
        leading: <ProviderMark id={provider.id} size={14} />,
      })),
    ),
  ];

  const effortOptions = [
    { id: '', label: 'Server default' },
    ...(status?.effortMenu ?? []).map((option) => ({
      id: option.id,
      label: option.label,
    })),
  ];

  const permissionOptions = [
    { id: '', label: 'Leave Aside’s default' },
    ...(status?.permissionMenu ?? []).map((option) => ({
      id: option.id,
      label: option.label,
    })),
  ];

  const service = status?.service;

  return (
    <div className="app settings-screen">
      <header className="thread-header">
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Back"
        >
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">Settings</span>
        </span>
        <span className="settings-brand">
          <AsideSymbol size={18} />
        </span>
      </header>

      <div className="settings-scroll">
        {error ? <p className="list-empty">{error}</p> : null}
        {!settings && !error ? (
          <p className="list-empty">
            <Spinner size={14} /> Loading…
          </p>
        ) : null}

        {settings ? (
          <>
            <Section
              title="New sessions"
              note="These apply to sessions you start from this app. They do not change Aside’s own settings on your computer."
            >
              <ChoiceRow
                title="Model"
                description="What a new session runs on."
                value={
                  settings.defaultProvider && settings.defaultModelId
                    ? `${settings.defaultProvider}/${settings.defaultModelId}`
                    : ''
                }
                options={modelOptions}
                onPick={(id) => {
                  const slash = id.indexOf('/');
                  save(
                    slash === -1
                      ? { defaultProvider: '', defaultModelId: '' }
                      : {
                          defaultProvider: id.slice(0, slash),
                          defaultModelId: id.slice(slash + 1),
                        },
                  );
                }}
              />
              <ChoiceRow
                title="Reasoning"
                description="How hard a new session thinks before answering."
                value={settings.defaultEffort}
                options={effortOptions}
                onPick={(id) => save({ defaultEffort: id })}
              />
              <ChoiceRow
                title="Permission"
                description="What a new session is allowed to do."
                value={settings.defaultPermissionMode ?? ''}
                options={permissionOptions}
                onPick={(id) =>
                  save({ defaultPermissionMode: id ? id : null })
                }
              />
              {/*
                Not the daemon's `finalConfirm`. That one mandates the
                native confirmation tool, which can only be answered from
                Aside on the desktop -- so on a session started here it
                guarantees a thread that dies at the first external action.
                This asks on a card the phone can answer instead.
              */}
              <Row
                title="Confirm before acting"
                description="A new session asks here, on a card you can answer, before anything external or irreversible."
                control={
                  <Switch
                    checked={settings.defaultFinalConfirm === true}
                    label="Confirm before acting by default"
                    onChange={(next) => save({ defaultFinalConfirm: next })}
                  />
                }
              />
            </Section>

            <Section
              title="Aside account"
              note="Read-only here. Change these in Aside on your computer."
            >
              <Row
                title="Account default model"
                description="What Aside itself uses when nothing overrides it."
                control={
                  <span className="settings-readout">
                    {status?.defaults.modelLabel || '—'}
                  </span>
                }
              />
              <Row
                title="Account reasoning"
                control={
                  <span className="settings-readout">
                    {status?.defaults.effortLabel || '—'}
                  </span>
                }
              />
            </Section>

            <Section title="Appearance">
              <ChoiceRow
                title="Theme"
                description="Choose the appearance for this browser."
                value={theme}
                options={[
                  { id: 'system', label: 'System' },
                  { id: 'light', label: 'Light' },
                  { id: 'dark', label: 'Dark' },
                ]}
                onPick={(id) => {
                  const next = id as ThemePreference;
                  setTheme(next);
                  setThemePreference(next);
                }}
              />
            </Section>

            {!inTelegram() ? (
              <Section
                title="Notifications"
                note="Notifications are sent when a task finishes or needs attention. Transcript text is never included in a push message."
              >
                <Row
                  title="Task notifications"
                  description={
                    pushSupported()
                      ? pushError || 'Works while this browser is closed.'
                      : 'This browser does not support Web Push.'
                  }
                  control={
                    <Switch
                      checked={pushOn}
                      label="Task notifications"
                      onChange={(next) => void togglePush(next)}
                    />
                  }
                />
                {pushBusy ? (
                  <p className="settings-inline-status"><Spinner size={13} /> Updating…</p>
                ) : null}
              </Section>
            ) : null}

            <Section title="Connection">
              <Row
                title="Aside daemon"
                control={
                  <span
                    className={`settings-readout ${
                      service?.asideReachable ? 'is-ok' : 'is-bad'
                    }`}
                  >
                    {service?.asideReachable ? 'Reachable' : 'Unreachable'}
                  </span>
                }
              />
              <Row
                title="Telegram bridge"
                description="The Python bridge that handles Telegram chat messages."
                control={
                  <span className="settings-readout">
                    {service?.bridgeConfigured ? 'Configured' : 'Not found'}
                  </span>
                }
              />
              <Row
                title="Tunnel"
                description={
                  service?.tunnelUrl || (
                    service?.tunnel !== 'none'
                      ? 'Starting…'
                      : 'Serving on the local network only.'
                  ) as string
                }
                control={
                  <span className="settings-readout">
                    {service?.tunnel === 'tailscale'
                      ? 'Tailscale Funnel'
                      : service?.tunnel === 'cloudflared'
                        ? 'cloudflared'
                        : 'Off'}
                  </span>
                }
              />
              <Row
                title="Mini app version"
                control={
                  <span className="settings-readout">
                    {service?.version || '—'}
                  </span>
                }
              />
            </Section>

            <Section title="Session">
              <button
                type="button"
                className="settings-action"
                onClick={() => {
                  void api.logout().then(onLogout, onLogout);
                }}
              >
                Sign out of this browser
              </button>
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}
