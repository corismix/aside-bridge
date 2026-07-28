/**
 * The app shell: a sidepanel home screen and a thread screen.
 *
 * Home is the composer card over the session list -- sending from it
 * starts a new session, which is why there is no separate new-chat
 * control. The thread screen carries the reply composer and the bottom
 * bar. Model, effort and permission controls appear on both and drive the
 * same state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionList } from './components/SessionList';
import { Thread } from './components/Thread';
import { BottomBar, Composer } from './components/Composer';
import { EffortPicker, ModelPicker, PermissionPicker } from './components/Pickers';
import { CitationSheet } from './components/Citations';
import { SessionPanel } from './components/SessionPanel';
import { StreamFooter, estimateTokens } from './components/StreamFooter';
import { ChevronLeft, PanelRight, Spinner } from './components/Icons';
import type { CitationMark } from './utils/citations';
import { api, setAuthToken } from './api';
import { useThread } from './hooks/useThread';
import { useAttachments } from './hooks/useAttachments';
import { resolvePills } from './utils/pills';
import {
  applyTheme,
  backButton,
  haptic,
  initTelegram,
  onThemeChanged,
  readInitData,
  stashDevInitData,
} from './telegram';
import type { SessionRow, StatusResponse } from './types';

/**
 * A thread on the navigation stack.
 *
 * `parentTitle` is set when this thread was opened from a subagent card, so
 * the header can say whose subagent it is. It comes from the caller rather
 * than from another lookup: whoever navigated here already had the title on
 * screen.
 */
interface ThreadScreenState {
  id: string;
  parentTitle?: string;
}
type AuthState =
  | { phase: 'pending' }
  | { phase: 'ready'; name?: string }
  | { phase: 'failed'; reason: string };

type PickerState =
  | { kind: 'none' }
  | { kind: 'model'; anchor: HTMLElement }
  | { kind: 'effort'; anchor: HTMLElement }
  | { kind: 'permission'; anchor: HTMLElement };

const PROVIDER_KEY = 'miniapp.provider';
const MODEL_KEY = 'miniapp.model';
const EFFORT_KEY = 'miniapp.effort';

/**
 * The permission menu, if /status has not answered yet.
 *
 * Hard-coded rather than left empty because these three are the daemon's
 * whole enum -- it validates against exactly this list -- so there is
 * nothing to discover and no risk of showing a mode that does not exist.
 */
const FALLBACK_PERMISSION_MENU = [
  { id: 'read-only', label: 'Read only' },
  { id: 'guard', label: 'Guard' },
  { id: 'full-access', label: 'Full access' },
];

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: 'pending' });
  /**
   * The open threads, innermost last. Home is the empty stack.
   *
   * A stack rather than a single screen because a subagent card opens the
   * child's own thread, and backing out of it has to land on the parent
   * rather than on the session list.
   */
  const [stack, setStack] = useState<ThreadScreenState[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [picker, setPicker] = useState<PickerState>({ kind: 'none' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const attachments = useAttachments();

  // A chosen model/effort sticks across launches; until one is chosen the
  // pills mirror whatever the daemon's own default is.
  const [provider, setProvider] = useState(
    () => localStorage.getItem(PROVIDER_KEY) || '',
  );
  const [modelId, setModelId] = useState(
    () => localStorage.getItem(MODEL_KEY) || '',
  );
  const [effort, setEffort] = useState(
    () => localStorage.getItem(EFFORT_KEY) || '',
  );

  /**
   * The permission a NEW session should get.
   *
   * There is no session to write to on the home screen, so the choice is
   * held here and applied right after the CLI hands back an id -- the same
   * create-then-update shape the Python bridge uses. `null` means "leave
   * the daemon's default alone", which is the honest default.
   */
  const [newMode, setNewMode] = useState<string | null>(null);
  const [newFinalConfirm, setNewFinalConfirm] = useState<boolean | null>(null);

  // --- auth ---------------------------------------------------------------
  useEffect(() => {
    initTelegram();
    applyTheme();
    const off = onThemeChanged(applyTheme);
    stashDevInitData(location.hash);

    const raw = readInitData();
    if (!raw) {
      setAuth({ phase: 'failed', reason: 'Open this from Telegram.' });
      return off;
    }
    api.auth(raw).then(
      (res) => {
        setAuthToken(res.token);
        setAuth({ phase: 'ready', name: res.user.firstName });
      },
      (err) => setAuth({ phase: 'failed', reason: (err as Error).message }),
    );
    return off;
  }, []);

  // --- data ---------------------------------------------------------------
  const loadSessions = useCallback(async () => {
    try {
      const res = await api.sessions();
      setSessions(res.sessions);
    } catch {
      // The list keeps its previous contents rather than blanking out.
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    if (auth.phase !== 'ready') return;
    void loadSessions();
    api.status().then(setStatus, () => {});
  }, [auth.phase, loadSessions]);

  // --- navigation ---------------------------------------------------------
  const screen = stack[stack.length - 1] as ThreadScreenState | undefined;

  // Keep the home list fresh so unread dots and running spinners track the
  // browser without a manual pull.
  useEffect(() => {
    if (auth.phase !== 'ready' || screen) return;
    const timer = window.setInterval(loadSessions, 8000);
    return () => window.clearInterval(timer);
  }, [auth.phase, screen, loadSessions]);

  const openThread = useCallback(
    (next: ThreadScreenState, replace = true) => {
      setStack((prev) => (replace ? [next] : [...prev, next]));
      setDraft('');
      attachments.clear();
    },
    [attachments],
  );

  /** Back: out of a subagent to its parent, or out of the last thread home. */
  const goBack = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
    setDraft('');
    attachments.clear();
    if (stack.length <= 1) void loadSessions();
  }, [loadSessions, attachments, stack.length]);

  useEffect(() => {
    if (!screen) return undefined;
    // show() hands back its own teardown, which both unbinds and hides.
    return backButton.show(goBack);
  }, [screen, goBack]);

  // --- pills --------------------------------------------------------------
  /**
   * An explicit local pick wins; otherwise the pills mirror the daemon's
   * own account default, so someone who has never chosen sees what the
   * browser would use. The precedence lives in `resolvePills`, which is
   * tested directly.
   */
  const pills = useMemo(
    () => resolvePills(status, { provider, modelId, effort }),
    [status, provider, modelId, effort],
  );

  const permissionMenu = status?.permissionMenu?.length
    ? status.permissionMenu
    : FALLBACK_PERMISSION_MENU;

  const pickModel = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider);
    setModelId(nextModel);
    localStorage.setItem(PROVIDER_KEY, nextProvider);
    localStorage.setItem(MODEL_KEY, nextModel);
    haptic('light');
  };

  const pickEffort = (next: string) => {
    setEffort(next);
    localStorage.setItem(EFFORT_KEY, next);
    haptic('light');
  };

  /** The CLI takes `provider/modelId`; a bare id means "daemon default". */
  const wireModel = () =>
    pills.provider && pills.modelId
      ? `${pills.provider}/${pills.modelId}`
      : undefined;

  // --- sending ------------------------------------------------------------
  const startSession = async () => {
    const text = draft.trim();
    const files = attachments.readyPaths();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    try {
      const res = await api.newSession({
        text,
        model: wireModel(),
        effort: pills.effortId,
        attachments: files,
        permissionMode: newMode ?? undefined,
        finalConfirm: newFinalConfirm ?? undefined,
      });
      setDraft('');
      attachments.clear();
      await loadSessions();
      openThread({ id: res.sessionId });
    } catch {
      // Surfaced by the thread's notices once the turn reports back.
    } finally {
      setSending(false);
    }
  };

  if (auth.phase === 'pending') {
    return (
      <div className="boot">
        <Spinner size={18} />
      </div>
    );
  }
  if (auth.phase === 'failed') {
    return (
      <div className="boot">
        <p className="boot-title">Can’t sign in</p>
        <p className="boot-reason">{auth.reason}</p>
      </div>
    );
  }

  const openModel = (anchor: HTMLElement) => setPicker({ kind: 'model', anchor });
  const openEffort = (anchor: HTMLElement) => setPicker({ kind: 'effort', anchor });
  const openPermission = (anchor: HTMLElement) =>
    setPicker({ kind: 'permission', anchor });
  const closePicker = () => setPicker({ kind: 'none' });

  /**
   * The open picker, with its checkmark on whatever the *caller* is
   * currently running -- the account default on home, the session's own
   * settings inside a thread.
   */
  const renderPicker = (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
  }) =>
    picker.kind === 'model' && status ? (
      <ModelPicker
        anchor={picker.anchor}
        catalog={status.catalog}
        currentProvider={current.provider}
        currentModel={current.modelId}
        onPick={pickModel}
        onClose={closePicker}
      />
    ) : picker.kind === 'effort' && status ? (
      <EffortPicker
        anchor={picker.anchor}
        options={status.effortMenu}
        current={current.effortId}
        onPick={pickEffort}
        onClose={closePicker}
      />
    ) : picker.kind === 'permission' ? (
      <PermissionPicker
        anchor={picker.anchor}
        options={permissionMenu}
        current={current.permissionMode}
        finalConfirm={current.finalConfirm}
        onPickMode={current.onPickMode}
        onToggleConfirm={current.onToggleConfirm}
        onClose={closePicker}
      />
    ) : null;

  if (!screen) {
    return (
      <div className="app">
        <main className="home">
          <Composer
            variant="home"
            value={draft}
            onChange={setDraft}
            onSubmit={startSession}
            pills={pills}
            onOpenModel={openModel}
            onOpenEffort={openEffort}
            onOpenPermission={openPermission}
            permissionMode={newMode}
            attachments={attachments.items}
            onAddFiles={(files) => attachments.add(files)}
            onRemoveAttachment={attachments.remove}
            busy={sending}
            disabled={sending}
          />
          <SessionList
            sessions={sessions}
            onOpen={(id) => openThread({ id })}
            loading={loadingSessions}
          />
        </main>
        {renderPicker({
          ...pills,
          permissionMode: newMode,
          finalConfirm: newFinalConfirm,
          onPickMode: (id) => {
            setNewMode(id);
            haptic('light');
          },
          onToggleConfirm: (next) => {
            setNewFinalConfirm(next);
            haptic('light');
          },
        })}
      </div>
    );
  }

  return (
    <ThreadScreen
      key={screen.id}
      sessionId={screen.id}
      parentTitle={screen.parentTitle}
      onBack={goBack}
      onInspectSubagent={(id, parentTitle) =>
        openThread({ id, parentTitle }, false)
      }
      pills={pills}
      // Whether the user has actively chosen; when they have not, the
      // thread shows the session's own model rather than the account
      // default, which is a different thing.
      hasModelOverride={Boolean(modelId)}
      hasEffortOverride={Boolean(effort)}
      draft={draft}
      setDraft={setDraft}
      attachments={attachments}
      openModel={openModel}
      openEffort={openEffort}
      openPermission={openPermission}
      renderPicker={renderPicker}
    />
  );
}

function ThreadScreen({
  sessionId,
  parentTitle,
  onBack,
  onInspectSubagent,
  pills,
  hasModelOverride,
  hasEffortOverride,
  draft,
  setDraft,
  attachments,
  openModel,
  openEffort,
  openPermission,
  renderPicker,
}: {
  sessionId: string;
  /** Set when this thread was opened from a subagent card. */
  parentTitle?: string;
  onBack: () => void;
  /** Push a child thread; the second argument is THIS thread's title. */
  onInspectSubagent: (childId: string, parentTitle: string) => void;
  pills: {
    provider: string;
    modelId: string;
    modelLabel: string;
    effortLabel: string;
    effortId: string;
  };
  hasModelOverride: boolean;
  hasEffortOverride: boolean;
  draft: string;
  setDraft: (value: string) => void;
  attachments: ReturnType<typeof useAttachments>;
  openModel: (anchor: HTMLElement) => void;
  openEffort: (anchor: HTMLElement) => void;
  openPermission: (anchor: HTMLElement) => void;
  renderPicker: (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
  }) => React.ReactNode;
}) {
  const thread = useThread(sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [citation, setCitation] = useState<CitationMark | null>(null);

  /**
   * What this thread is actually running.
   *
   * Precedence: an explicit choice by the user, else the model the daemon
   * has pinned to this session, else the account default. The middle case
   * is the one that was missing -- the bar used to show the account
   * default on every session regardless of what it was really using.
   */
  const effective = {
    provider: hasModelOverride
      ? pills.provider
      : thread.model?.provider || pills.provider,
    modelId: hasModelOverride
      ? pills.modelId
      : thread.model?.modelId || pills.modelId,
    modelLabel: hasModelOverride
      ? pills.modelLabel
      : thread.model?.label || pills.modelLabel,
    effortId: hasEffortOverride
      ? pills.effortId
      : thread.model?.effort || pills.effortId,
    effortLabel: hasEffortOverride
      ? pills.effortLabel
      : thread.model?.effortLabel || pills.effortLabel,
  };

  // Stay pinned to the newest content while a turn streams, but never yank
  // the view away from someone who has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [thread.items]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const send = async () => {
    const text = draft.trim();
    const files = attachments.ready();
    if ((!text && !files.length) || sending) return;
    setSending(true);

    // The bubble goes up before the request does. This is the fix for
    // "the message I send isn't viewable right away": nothing about the
    // send needs to have succeeded for the user to see what they typed.
    thread.addPending({
      text,
      attachments: files.map((f) => ({ name: f.name, mimeType: f.mimeType })),
      at: Date.now(),
    });
    setDraft('');
    attachments.clear();
    pinned.current = true;

    try {
      // Send what the bar says. Passing the session's own model explicitly
      // keeps a continuation on the model it was already using instead of
      // silently switching it to the account default.
      await api.send(sessionId, {
        text,
        model:
          effective.provider && effective.modelId
            ? `${effective.provider}/${effective.modelId}`
            : undefined,
        effort: effective.effortId,
        attachments: files.map((f) => f.path!).filter(Boolean),
      });
    } finally {
      setSending(false);
    }
  };

  const setPermission = async (patch: {
    mode?: string;
    finalConfirm?: boolean;
  }) => {
    haptic('light');
    // Optimistic, then corrected by what the daemon reports back.
    thread.applyPermission({
      permission: thread.permission,
      permissionMode: patch.mode ?? thread.permissionMode,
      finalConfirm: patch.finalConfirm ?? thread.finalConfirm,
    });
    try {
      const res = await api.permission(sessionId, patch);
      thread.applyPermission({
        permission: res.permission,
        permissionMode: res.permissionMode,
        finalConfirm: res.finalConfirm,
      });
    } catch {
      // Put the truth back: re-read rather than leaving a claim we cannot
      // stand behind on screen.
      thread.refresh();
    }
  };

  return (
    <div className="app">
      <header className="thread-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">{thread.title}</span>
          {thread.parentId ? (
            <span className="thread-subtitle">
              {parentTitle ? `Subagent of ${parentTitle}` : 'Subagent'}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            haptic('light');
            setPanelOpen(true);
          }}
          aria-label="Session panel"
        >
          <PanelRight size={19} strokeWidth={1.75} />
        </button>
      </header>

      <div className="thread-scroll" ref={scroller} onScroll={onScroll}>
        {thread.loading && thread.items.length === 0 ? (
          <p className="list-empty">Loading…</p>
        ) : null}
        {thread.error && thread.items.length === 0 ? (
          <p className="list-empty">{thread.error}</p>
        ) : null}

        <Thread
          items={thread.items}
          sessionId={sessionId}
          sources={thread.sources}
          subagentSteps={thread.subagentSteps}
          onInspectSubagent={(childId) =>
            onInspectSubagent(childId, thread.title)
          }
          onOpenCitation={setCitation}
        />

        {thread.busy && thread.stats.turnStartedAt ? (
          <StreamFooter
            startedAt={thread.stats.turnStartedAt}
            tokens={
              thread.stats.turnTokens + estimateTokens(thread.streamingChars)
            }
          />
        ) : null}

        {thread.notices.map((notice, index) => (
          <div key={index} className="system-error">
            {notice}
          </div>
        ))}
      </div>

      <footer className="thread-footer">
        <Composer
          variant="reply"
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          pills={effective}
          onOpenModel={openModel}
          onOpenEffort={openEffort}
          onOpenPermission={openPermission}
          permissionMode={thread.permissionMode}
          attachments={attachments.items}
          onAddFiles={(files) => attachments.add(files, sessionId)}
          onRemoveAttachment={attachments.remove}
          busy={sending}
          disabled={sending}
        />
        <BottomBar
          permission={thread.permission}
          pills={effective}
          onOpenModel={openModel}
          onOpenEffort={openEffort}
          onOpenPermission={openPermission}
          context={{
            used: thread.stats.totalTokens,
            window: thread.contextWindow,
          }}
        />
      </footer>

      {panelOpen ? (
        <SessionPanel
          sessionId={sessionId}
          subagents={thread.subagents}
          onInspectSubagent={(childId) => {
            setPanelOpen(false);
            onInspectSubagent(childId, thread.title);
          }}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}

      {citation ? (
        <CitationSheet
          mark={citation}
          sources={thread.sources}
          onClose={() => setCitation(null)}
        />
      ) : null}

      {renderPicker({
        ...effective,
        permissionMode: thread.permissionMode,
        finalConfirm: thread.finalConfirm,
        onPickMode: (id) => void setPermission({ mode: id }),
        onToggleConfirm: (next) => void setPermission({ finalConfirm: next }),
      })}
    </div>
  );
}
