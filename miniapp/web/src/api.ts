/** REST + WebSocket client. Same origin as the SPA. */
import type {
  ArtifactGroup,
  ArtifactsResponse,
  AuthResponse,
  ChildSteps,
  CitationSource,
  Entry,
  ErrorAlert,
  MessagesResponse,
  MiniappSettings,
  SessionRow,
  StatusResponse,
  ThreadItem,
  ThreadResponse,
  ThreadStats,
  Todo,
  UploadedFile,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`${status}: ${reason}`);
    this.name = 'ApiError';
  }
}

let authToken = '';

export function setAuthToken(token: string): void {
  authToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (authToken) headers.set('authorization', `Bearer ${authToken}`);

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, body.reason || body.error || res.statusText);
  }
  return body as T;
}

export const api = {
  auth: (initDataRaw: string) =>
    request<AuthResponse>('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ initDataRaw }),
    }),

  sessions: (limit = 100) =>
    request<{ sessions: SessionRow[]; source: string }>(
      `/api/sessions?limit=${limit}`,
    ),

  /** Primary thread read: structured, from the daemon's own transcript. */
  thread: (sessionId: string) =>
    request<ThreadResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/thread`,
    ),

  /**
   * Raw transcript entries.
   *
   * Kept because `/api/sessions/:id/messages` is still served, but note that
   * nothing in this app calls it: rounds 1-2 polled it, and round 3 replaced
   * that with server-built thread deltas over the socket. It is a debugging
   * affordance now, not a code path.
   */
  messages: (sessionId: string, afterLine = -1) =>
    request<MessagesResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?afterLine=${afterLine}`,
    ),

  send: (
    sessionId: string,
    payload: {
      text: string;
      model?: string;
      effort?: string;
      attachments?: string[];
    },
  ) =>
    request<{ accepted: boolean; queued: number; busy: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/send`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  newSession: (payload: {
    text: string;
    model?: string;
    effort?: string;
    attachments?: string[];
    permissionMode?: string;
    finalConfirm?: boolean;
  }) =>
    request<{ sessionId: string; accepted: boolean }>('/api/sessions/new', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /**
   * Change a session's permission mode / final-confirm toggle.
   *
   * The response echoes what the daemon now has, read back from its own
   * state, so the UI checkmarks reality rather than the request.
   */
  permission: (
    sessionId: string,
    payload: { mode?: string; finalConfirm?: boolean },
  ) =>
    request<{
      ok: boolean;
      permission: string | null;
      permissionMode: string | null;
      finalConfirm: boolean | null;
      appliesFrom: string;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /**
   * Upload files. `sessionId` is optional -- the home composer has no
   * session yet, and the paths are handed back either way.
   */
  upload: async (files: File[], sessionId?: string) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    const headers = new Headers();
    // NB: content-type is deliberately NOT set. The browser has to add the
    // multipart boundary itself, and setting it by hand breaks the parse.
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);

    const path = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/attachments`
      : '/api/attachments';
    const res = await fetch(path, { method: 'POST', body: form, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new ApiError(res.status, body.reason || body.error || res.statusText);
    }
    return body as { files: UploadedFile[] };
  },

  /**
   * Stop the running turn.
   *
   * The server kills the driver child it owns, by PID. A 409 means there
   * was nothing running -- which is not an error worth surfacing, the
   * composer re-enables either way.
   */
  stop: (sessionId: string) =>
    request<{ ok: boolean; stopping: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /**
   * Answer a soft-protocol question by sending the choice as a message.
   *
   * Only ever used for `source: 'marker'` questions; a native pending tool
   * is answered from the desktop app and the card says so.
   */
  answer: (
    sessionId: string,
    payload: { header: string; label: string; model?: string; effort?: string },
  ) =>
    request<{ accepted: boolean; queued: number; busy: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/answer`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  status: () => request<StatusResponse>('/api/status'),

  settings: () => request<{ settings: MiniappSettings }>('/api/settings'),

  saveSettings: (patch: Partial<MiniappSettings>) =>
    request<{ settings: MiniappSettings }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  /** The session's own files, grouped into artifacts and attachments. */
  artifacts: (sessionId: string) =>
    request<ArtifactsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    ),

  /**
   * One artifact's bytes.
   *
   * Fetched rather than linked so the bearer token stays in a header and
   * out of the DOM; `artifactUrl` below is only for handing a download to
   * the client, which cannot set headers.
   */
  artifactBlob: async (
    sessionId: string,
    group: ArtifactGroup,
    path: string,
  ): Promise<Blob> => {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const res = await fetch(artifactPath(sessionId, group, path), { headers });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.blob();
  },

  artifactUrl: (sessionId: string, group: ArtifactGroup, path: string) =>
    `${artifactPath(sessionId, group, path)}&token=${encodeURIComponent(authToken)}`,

  /**
   * A local image an answer points at, by absolute path.
   *
   * Carries the token in the query for the same reason `artifactUrl` does:
   * this URL goes into an `<img src>`, and a tag cannot set a header. The
   * server redacts query strings from its logs.
   */
  localFileUrl: (sessionId: string, absPath: string) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(
      absPath,
    )}&token=${encodeURIComponent(authToken)}`,
};

function artifactPath(
  sessionId: string,
  group: ArtifactGroup,
  path: string,
): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/file?group=${group}&path=${encodeURIComponent(path)}`;
}

export type SocketEvent =
  | { type: 'ready' }
  | { type: 'subscribed'; sessionId: string; busy: boolean; queued: number; length: number }
  /** Replace items from `fromIndex` onward; `length` is the new total. */
  | { type: 'thread_delta'; sessionId: string; fromIndex: number; items: ThreadItem[]; length: number }
  /** Token counters and the citation catalog; moves independently of items. */
  | {
      type: 'thread_meta';
      sessionId: string;
      stats: ThreadStats;
      sources: Record<string, CitationSource>;
      todos: Todo[];
    }
  /** One subagent's own timeline, as it works. */
  | ({ type: 'subagent_delta'; sessionId: string } & ChildSteps)
  /** Provisional text off the running child's stdout. */
  | { type: 'stream_delta'; sessionId: string; text: string }
  | { type: 'entries'; sessionId: string; entries: Entry[] }
  | { type: 'turn_started'; sessionId: string; model: string; effort: string; startedAt: number }
  | {
      type: 'turn_finished';
      sessionId: string;
      exitCode: number | null;
      durationMs: number;
      error?: string;
      /** The failure as a card; drawn by `ErrorCard`. */
      alert?: ErrorAlert;
      /** The user tapped Stop. Not a failure. */
      stopped?: boolean;
      /** The driver was reaped because the session suspended on a question. */
      suspended?: boolean;
    }
  | { type: 'error'; reason: string }
  | { type: 'pong' };

/**
 * Live thread socket with reconnect.
 *
 * A reconnect resubscribes from scratch, and the server answers a fresh
 * subscribe by treating what is on disk as the baseline. Anything that
 * landed while the socket was down therefore arrives with the next change
 * or, at the latest, on the forced resync at `turn_finished` -- and
 * `resync()` is there for a client that knows it has fallen behind.
 */
export class TranscriptSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: number | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly onEvent: (event: SocketEvent) => void,
    private readonly onOpenState?: (connected: boolean) => void,
  ) {}

  connect(): void {
    if (this.closed) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/ws?token=${encodeURIComponent(
      authToken,
    )}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onOpenState?.(true);
      ws.send(
        JSON.stringify({ type: 'subscribe', sessionId: this.sessionId }),
      );
    };
    ws.onmessage = (event) => {
      try {
        this.onEvent(JSON.parse(event.data) as SocketEvent);
      } catch {
        // ignore unparsable frames
      }
    };
    ws.onclose = () => {
      this.onOpenState?.(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(500 * 2 ** this.retry, 10_000);
    this.retry += 1;
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  /** Ask the server to re-send the whole thread. */
  resync(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resync' }));
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
