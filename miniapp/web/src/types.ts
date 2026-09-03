/** Wire types, mirroring miniapp/server/src/{thread,sessions,catalog}.ts. */

// --- raw transcript entries (live-streaming deltas only) -----------------

export type EntryKind =
  | 'user'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'subagent';

export interface BaseEntry {
  line: number;
  part: number;
  id: string;
  ts: number | null;
}

export interface UserEntry extends BaseEntry {
  kind: 'user';
  text: string;
}
export interface AssistantTextEntry extends BaseEntry {
  kind: 'assistant_text';
  text: string;
  model?: string;
}
export interface ThinkingEntry extends BaseEntry {
  kind: 'thinking';
  text: string;
}
export interface ToolCallEntry extends BaseEntry {
  kind: 'tool_call';
  toolCallId?: string;
  name: string;
  title: string;
}
export interface ToolResultEntry extends BaseEntry {
  kind: 'tool_result';
  toolCallId?: string;
  name: string;
  isError: boolean;
  preview: string;
}
export interface SubagentEntry extends BaseEntry {
  kind: 'subagent';
  event: 'spawn' | 'wait' | 'result';
  taskId?: string;
  callId?: string;
  desc: string;
  profile?: string;
  background?: boolean;
  text?: string;
  isError?: boolean;
}

export type Entry =
  | UserEntry
  | AssistantTextEntry
  | ThinkingEntry
  | ToolCallEntry
  | ToolResultEntry
  | SubagentEntry;

// --- the thread, as the sidepanel draws it -------------------------------

export type StepIcon =
  | 'terminal'
  | 'globe'
  | 'file'
  | 'search'
  | 'list'
  | 'agent'
  | 'clock'
  | 'bell'
  | 'shield'
  | 'dot';

export interface StepDetail {
  command?: string;
  output?: string;
  truncated?: boolean;
}

/** A subagent session, joined to its spawn by `toolCallId`. */
export interface ChildSession {
  id: string;
  title: string;
  status: string;
  toolCallId: string;
  modelLabel: string | null;
  /** Provider id behind `modelLabel`, for the card's brand mark. */
  provider?: string | null;
  running: boolean;
  /** Same palette slot as the spawn row that created it. */
  hue?: number;
}

export interface SubagentSpawn {
  callId: string;
  description: string;
  prompt: string;
  /** Palette slot for the creature, handed out server-side in spawn order. */
  hue: number;
  child?: ChildSession;
}

export interface FileEditLine {
  n: number | null;
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

export interface FileEdit {
  mode: 'write' | 'edit';
  path: string;
  name: string;
  lines: FileEditLine[];
  truncated: boolean;
}

export interface WorkStep {
  kind: 'step';
  id: string;
  icon: StepIcon;
  label: string;
  tool: string;
  status: 'success' | 'error' | 'pending';
  diffstat: { added: number; removed: number } | null;
  detail: StepDetail | null;
  images: string[];
  /** Images the server's inline caps left out; the card says so. */
  imagesDropped?: number;
  /** Set on `subagent` spawns: draw a nested agent card. */
  subagent?: SubagentSpawn;
  /** Set on file writes and edits: draw a diff card. */
  file?: FileEdit;
}

/** A subagent's own timeline, pushed as it works. */
export interface ChildSteps {
  childId: string;
  steps: WorkStep[];
  /** Total steps taken, including any older than the ones sent. */
  total: number;
}

export interface WorkText {
  kind: 'text';
  id: string;
  text: string;
}

export type WorkItem = WorkStep | WorkText;

export interface Attachment {
  name: string;
  mimeType?: string;
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  ts: number | null;
  attachments?: Attachment[];
  /** Client-only: shown immediately on send, before the transcript has it. */
  pending?: boolean;
}

export interface WorkBlock {
  kind: 'work';
  id: string;
  items: WorkItem[];
  durationMs: number;
  running: boolean;
}

export interface AnswerItem {
  kind: 'answer';
  id: string;
  text: string;
  model?: string;
  provider?: string;
  ts: number | null;
}

/** A classified failure, as `server/src/errors.ts` produces it. */
export interface ErrorAlert {
  title: string;
  description: string;
  /** The raw provider message, shown behind the card's Details button. */
  detail: string;
  tone: 'muted' | 'destructive';
}

export interface ErrorItem {
  kind: 'error';
  id: string;
  text: string;
  alert: ErrorAlert;
  ts: number | null;
}

// --- questions -----------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionBlock {
  header: string;
  question: string;
  options: QuestionOption[];
}

export interface QuestionArtifact {
  type: string;
  summary: Array<{ label: string; value: string }>;
}

/**
 * A question the agent has put to the user.
 *
 * `answerable` is the field that matters: a NATIVE pending tool
 * (`source: 'tool'`) can only be answered from the desktop sidepanel, so
 * the card renders read-only with a notice. A soft-marker question
 * (`source: 'marker'`) is answered by sending an ordinary message.
 */
export interface QuestionItem {
  kind: 'question';
  id: string;
  variant: 'ask' | 'confirm';
  source: 'tool' | 'marker';
  questions: QuestionBlock[];
  artifact?: QuestionArtifact;
  status: 'pending' | 'answered';
  answer?: string;
  answerable: boolean;
}

// --- todos ---------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * The answer as it is being generated, straight off the CLI's stdout.
 *
 * Provisional: it is replaced by a real `answer` item the moment that
 * message's transcript line is written, and is never persisted.
 */
export interface StreamingItem {
  kind: 'streaming';
  id: string;
  text: string;
}

export type ThreadItem =
  | UserItem
  | WorkBlock
  | AnswerItem
  | ErrorItem
  | QuestionItem
  | StreamingItem;

/** The session's own model, as the daemon has it pinned. */
export interface ThreadModel {
  provider: string;
  modelId: string;
  label: string;
  effort: string | null;
  effortLabel: string | null;
}

/** A web source an answer's citations can point at. */
export interface CitationSource {
  id: string;
  url: string;
  title: string;
  domain: string;
  excerpt: string;
}

/** Token counters behind the context ring and the streaming footer. */
export interface ThreadStats {
  /** Newest `usage.totalTokens` -- how full the context window is. */
  totalTokens: number;
  /** Output tokens produced since the last user message. */
  turnTokens: number;
  turnStartedAt: number | null;
}

export interface ThreadResponse {
  sessionId: string;
  title: string;
  status: string;
  /**
   * Blocked on a native question tool the desktop app alone can answer.
   * The composer disables itself on this rather than queuing a turn that
   * would hang. See `server/src/questions.ts`.
   */
  suspended: boolean;
  items: ThreadItem[];
  /** The agent's task list, replayed from its `write_todos` calls. */
  todos: Todo[];
  stats: ThreadStats;
  sources: Record<string, CitationSource>;
  subagents: ChildSession[];
  subagentSteps: ChildSteps[];
  /** Set when this session is itself a subagent of another. */
  parentId: string | null;
  /** Denominator of the context ring, in tokens. */
  contextWindow: number;
  busy: boolean;
  queued: number;
  /** Real permission mode; null means unreadable, so show nothing. */
  permission: string | null;
  /** The raw enum (`guard`, `full-access`, …) the picker checkmarks. */
  permissionMode: string | null;
  /**
   * What the confirm-before-acting switch shows.
   *
   * On a session driven from a phone that is this app's SOFT flag, not
   * the daemon's `runtimeConfig.finalConfirm` -- which is held at false
   * there on purpose, because it mandates the one tool that bricks a
   * mobile session. Null means unreadable.
   */
  finalConfirm: boolean | null;
  /** True when the confirm toggle means the soft protocol, not the daemon's. */
  softConfirm?: boolean;
  /** Per-session model; null means fall back to the account default. */
  model: ThreadModel | null;
}

/** A file uploaded from the phone, as the server stored it. */
export interface UploadedFile {
  /** Absolute path on the machine; passed back verbatim on send. */
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

/** A composer chip: an upload in flight, done, or failed. */
export interface ComposerAttachment {
  /** Client-side id, stable for the chip's lifetime. */
  key: string;
  name: string;
  mimeType: string;
  /** Object URL for image previews; revoked when the chip goes away. */
  previewUrl?: string;
  status: 'uploading' | 'ready' | 'failed';
  /** Set once the server has it. */
  path?: string;
  error?: string;
}

// --- session list --------------------------------------------------------

/**
 * Note what is absent: no visible id, no cost, no token count, no turn
 * count. The sidepanel shows none of those.
 */
export interface SessionRow {
  id: string;
  title: string;
  preview: string;
  status: 'running' | 'idle' | 'errored' | string;
  updatedAt: number;
  createdAt: number;
  unread: boolean;
  trigger?: string;
}

// --- status / catalog ----------------------------------------------------

export interface CatalogModel {
  id: string;
  label: string;
  /** Context window in tokens -- the ring's denominator. */
  contextWindow: number;
}

export interface CatalogProvider {
  id: string;
  label: string;
  models: CatalogModel[];
  connected: boolean;
}

export interface StatusResponse {
  uptimeMs: number;
  inFlight: Array<{
    sessionId: string;
    model: string;
    effort: string;
    startedAt: number;
    pending?: boolean;
  }>;
  queued: Record<string, number>;
  catalog: CatalogProvider[];
  efforts: string[];
  effortMenu: Array<{ id: string; label: string }>;
  permissionMenu: Array<{ id: string; label: string }>;
  uploads: { maxFiles: number; maxBytes: number };
  defaults: {
    provider: string;
    modelId: string;
    modelLabel: string;
    effort: string;
    effortLabel: string;
  };
  permission: string;
  /** Connection facts for the settings screen. Nothing sensitive here. */
  service: {
    version: string;
    tunnel: 'cloudflared' | 'none';
    tunnelUrl: string | null;
    port: number;
    asideReachable: boolean;
    bridgeConfigured: boolean;
  };
}

/** Defaults for sessions this app creates. See `server/src/settings.ts`. */
export interface MiniappSettings {
  defaultProvider: string;
  defaultModelId: string;
  defaultEffort: string;
  defaultPermissionMode: string | null;
  defaultFinalConfirm: boolean | null;
}

export interface MessagesResponse {
  sessionId: string;
  entries: Entry[];
  truncated: boolean;
  lastLine: number;
  busy: boolean;
  queued: number;
}

// --- session files -------------------------------------------------------

export type ArtifactGroup = 'artifacts' | 'attachments';
export type ArtifactKind = 'markdown' | 'image' | 'code' | 'text' | 'binary';

export interface ArtifactFile {
  /** Relative to the group directory; the id sent back to fetch it. */
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: ArtifactKind;
}

export interface ArtifactsResponse {
  sessionId: string;
  groups: Array<{ id: ArtifactGroup; files: ArtifactFile[] }>;
}

export interface AuthResponse {
  token: string;
  user: { id: number; firstName?: string; username?: string };
  expiresIn: number;
}

export interface AsideProject {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  workspacePath: string;
  lastActiveAt?: string;
  createdAt?: string;
  updatedAt?: string;
}
