/**
 * A live thread.
 *
 * Round 2 treated the socket as a doorbell: "something changed" arrived,
 * and the client answered by refetching the entire structured thread
 * through the CLI facade, throttled to 1.2s. That is why a reply appeared
 * all at once -- nothing could be drawn until a process spawn had returned
 * the whole turn.
 *
 * Now the server sends the thread itself, as tail deltas, and this hook
 * only applies them. Three layers stack, from most to least authoritative:
 *
 *  1. `thread_delta` -- built from the transcript. Truth.
 *  2. `stream_delta` -- the answer as the CLI writes it to stdout, shown as
 *     a live paragraph. Dropped the instant a delta covers it, because the
 *     transcript's version is the real one.
 *  3. the optimistic echo -- the message the user just sent, appended
 *     locally so the bubble appears on tap instead of when the first reply
 *     lands. Retired as soon as the same text shows up in the thread.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TranscriptSocket, api } from '../api';
import type {
  Attachment,
  ChildSession,
  ChildSteps,
  CitationSource,
  ThreadItem,
  ThreadModel,
  ThreadResponse,
  ThreadStats,
  UserItem,
} from '../types';

/** Give up on an un-echoed optimistic bubble after this long. */
const PENDING_TTL_MS = 120_000;

export interface PendingMessage {
  text: string;
  attachments: Attachment[];
  at: number;
}

export interface ThreadState {
  items: ThreadItem[];
  title: string;
  busy: boolean;
  queued: number;
  /** Null means "not known" -- the caller must hide, not guess. */
  permission: string | null;
  permissionMode: string | null;
  finalConfirm: boolean | null;
  model: ThreadModel | null;
  /** Token counters for the context ring and the streaming footer. */
  stats: ThreadStats;
  /** Ring denominator, in tokens. */
  contextWindow: number;
  /** Web sources any citation in this thread can resolve against. */
  sources: Record<string, CitationSource>;
  /** Every subagent of this session, for the panel. */
  subagents: ChildSession[];
  /** Each subagent's own timeline, keyed by child session id. */
  subagentSteps: Record<string, ChildSteps>;
  /** Set when this session is itself a subagent. */
  parentId: string | null;
  /** Characters streamed so far this turn, for the footer's estimate. */
  streamingChars: number;
  loading: boolean;
  error: string | null;
  connected: boolean;
  /** Daemon-level failures, surfaced inline under the thread. */
  notices: string[];
  refresh: () => void;
  dismissNotices: () => void;
  /** Show a just-sent message immediately, before the transcript has it. */
  addPending: (message: PendingMessage) => void;
  /** Reflect a permission change without waiting for a refetch. */
  applyPermission: (next: {
    permission: string | null;
    permissionMode: string | null;
    finalConfirm: boolean | null;
  }) => void;
}

/** Apply a tail delta: keep the prefix, replace everything from `fromIndex`. */
export function applyDelta(
  prev: ThreadItem[],
  delta: { fromIndex: number; items: ThreadItem[]; length: number },
): ThreadItem[] {
  const head = prev.slice(0, Math.max(0, delta.fromIndex));
  const next = [...head, ...delta.items];
  // `length` is authoritative, so a thread that shrank truncates rather
  // than keeping orphaned items from the previous build.
  return next.length > delta.length ? next.slice(0, delta.length) : next;
}

/** True once the transcript carries the message the echo was standing in for. */
export function pendingIsEchoed(
  items: ThreadItem[],
  pending: PendingMessage,
): boolean {
  const needle = pending.text.trim();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'user') continue;
    const text = item.text.trim();
    // The server prepends an attachment header to the prompt, so the
    // transcript's copy CONTAINS the typed text rather than equalling it.
    if (text === needle || (needle && text.endsWith(needle))) return true;
    // Only the newest user bubble can be the echo; anything older is a
    // previous turn, and scanning past it would match a repeated message.
    return false;
  }
  return false;
}

const NO_STATS: ThreadStats = {
  totalTokens: 0,
  turnTokens: 0,
  turnStartedAt: null,
};

/** Index a subagent-steps list by child id, for O(1) lookup while rendering. */
function byChildId(list: ChildSteps[]): Record<string, ChildSteps> {
  return Object.fromEntries(list.map((entry) => [entry.childId, entry]));
}

export function useThread(sessionId: string): ThreadState {
  const [meta, setMeta] = useState<ThreadResponse | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [stats, setStats] = useState<ThreadStats>(NO_STATS);
  const [sources, setSources] = useState<Record<string, CitationSource>>({});
  const [subagentSteps, setSubagentSteps] = useState<Record<string, ChildSteps>>(
    {},
  );
  const [streamText, setStreamText] = useState('');
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  /**
   * Busy, as the socket reports it.
   *
   * The REST payload's `busy` is a snapshot from load time, so relying on
   * it alone leaves the bottom bar's spinner stuck on whatever the state
   * was when the thread opened. `null` means "the socket has not said",
   * and the REST value stands.
   */
  const [liveBusy, setLiveBusy] = useState<boolean | null>(null);

  const alive = useRef(true);
  const socket = useRef<TranscriptSocket | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.thread(sessionId);
      if (!alive.current) return;
      setMeta(next);
      setItems(next.items);
      setStats(next.stats);
      setSources(next.sources);
      setSubagentSteps(byChildId(next.subagentSteps));
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError((err as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setNotices([]);
    setItems([]);
    setStats(NO_STATS);
    setSources({});
    setSubagentSteps({});
    setStreamText('');
    setPending(null);
    setLiveBusy(null);
    void load();

    const ws = new TranscriptSocket(
      sessionId,
      (event) => {
        if (event.type === 'thread_delta') {
          setItems((prev) => applyDelta(prev, event));
          // The transcript now carries whatever was being streamed, so the
          // provisional buffer has served its purpose.
          setStreamText('');
          return;
        }
        if (event.type === 'thread_meta') {
          setStats(event.stats);
          setSources(event.sources);
          return;
        }
        if (event.type === 'subagent_delta') {
          const { childId, steps, total } = event;
          setSubagentSteps((prev) => ({
            ...prev,
            [childId]: { childId, steps, total },
          }));
          return;
        }
        if (event.type === 'stream_delta') {
          setStreamText((prev) => prev + event.text);
          return;
        }
        if (event.type === 'subscribed') {
          setLiveBusy(event.busy);
          return;
        }
        if (event.type === 'turn_started') {
          setLiveBusy(true);
          setStreamText('');
          return;
        }
        if (event.type === 'turn_finished') {
          if (event.error) setNotices((prev) => [...prev, event.error!]);
          setLiveBusy(false);
          setStreamText('');
          // Metadata the socket does not carry (title, permission, model).
          void load();
        }
      },
      (isConnected) => {
        setConnected(isConnected);
        // A socket that just came back may have missed writes; the server
        // answers `resync` with the whole thread.
        if (isConnected) socket.current?.resync();
      },
    );
    socket.current = ws;
    ws.connect();

    return () => {
      alive.current = false;
      ws.close();
      socket.current = null;
    };
  }, [sessionId, load]);

  // Retire the optimistic bubble once the real one arrives -- or after a
  // couple of minutes, so a failed send does not leave a ghost forever.
  useEffect(() => {
    if (!pending) return undefined;
    if (pendingIsEchoed(items, pending)) {
      setPending(null);
      return undefined;
    }
    const timer = window.setTimeout(
      () => setPending(null),
      Math.max(0, pending.at + PENDING_TTL_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [items, pending]);

  const visible = useMemo(() => {
    const out = [...items];
    if (pending) {
      const echo: UserItem = {
        kind: 'user',
        id: `pending-${pending.at}`,
        text: pending.text,
        ts: pending.at,
        pending: true,
      };
      if (pending.attachments.length) echo.attachments = pending.attachments;
      out.push(echo);
    }
    const streaming = streamText.trim();
    if (streaming) {
      out.push({ kind: 'streaming', id: 'streaming', text: streaming });
    }
    return out;
  }, [items, pending, streamText]);

  return {
    items: visible,
    title: meta?.title ?? '',
    busy: liveBusy ?? meta?.busy ?? false,
    queued: meta?.queued ?? 0,
    permission: meta?.permission ?? null,
    permissionMode: meta?.permissionMode ?? null,
    finalConfirm: meta?.finalConfirm ?? null,
    model: meta?.model ?? null,
    stats,
    contextWindow: meta?.contextWindow ?? 0,
    sources,
    subagents: meta?.subagents ?? [],
    subagentSteps,
    parentId: meta?.parentId ?? null,
    streamingChars: streamText.length,
    loading,
    error,
    connected,
    notices,
    refresh: load,
    dismissNotices: () => setNotices([]),
    addPending: (message) => setPending(message),
    applyPermission: (next) =>
      setMeta((prev) => (prev ? { ...prev, ...next } : prev)),
  };
}
