/**
 * Test rig: a throwaway bridge config + a writable copy of the fixture
 * sessions dir. No real token, no real transcript, ever.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const FAKE_BOT_TOKEN = '1234567890:TEST-ONLY-FAKE-BOT-TOKEN-not-real';
export const OWNER_ID = 8675309;

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_SESSIONS = path.join(here, 'fixtures', 'sessions');

export interface TestEnv {
  root: string;
  configPath: string;
  sessionsDir: string;
  secretPath: string;
  stateDbPath: string;
  /** Where this app stores what the phone uploaded. */
  uploadsDir: string;
  /** Where bridge.py stores what arrived over Telegram. */
  mediaDir: string;
  cleanup: () => void;
}

/** A row as the daemon's `sessions` table stores one. Seconds, not ms. */
export interface FixtureSessionRow {
  id: string;
  title?: string;
  trigger?: string | null;
  status?: string;
  readAt?: number;
  updatedAt?: number;
  createdAt?: number;
  archivedAt?: number | null;
  ephemeral?: number;
  incognito?: number;
  parentId?: string | null;
  permissionMode?: string;
  model?: string | null;
  runtimeConfig?: string;
}

/**
 * A state.db shaped like the daemon's, for the list and permission reads.
 *
 * Column set and types mirror the live table -- notably `read_at`,
 * `updated_at` and `created_at` are unix SECONDS, and `trigger` is a JSON
 * string rather than a bare type.
 */
export function makeStateDb(file: string, rows: FixtureSessionRow[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL DEFAULT 'New Session',
    trigger TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    model TEXT NOT NULL DEFAULT '{}',
    permission_mode TEXT NOT NULL DEFAULT 'guard',
    incognito INTEGER NOT NULL DEFAULT 0,
    ephemeral INTEGER NOT NULL DEFAULT 0,
    runtime_config TEXT NOT NULL DEFAULT '{}',
    read_at INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);

  const insert = db.prepare(
    `INSERT INTO sessions
       (id, parent_id, title, trigger, status, model, permission_mode,
        incognito, ephemeral, runtime_config, read_at, archived_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.parentId ?? null,
      row.title ?? 'New Session',
      row.trigger ?? null,
      row.status ?? 'idle',
      row.model ?? '{}',
      row.permissionMode ?? 'guard',
      row.incognito ?? 0,
      row.ephemeral ?? 0,
      row.runtimeConfig ?? '{}',
      row.readAt ?? 0,
      row.archivedAt ?? null,
      row.createdAt ?? 0,
      row.updatedAt ?? 0,
    );
  }
  db.close();
  return file;
}

/**
 * The default fixture table.
 *
 * One row per case the list filter has to get right: a browser session, a
 * CLI session (no trigger, placeholder title, ephemeral -- the shape the
 * Telegram bridge and this app's own sends produce), a subagent child, an
 * archived session and an incognito one.
 */
export function defaultFixtureRows(): FixtureSessionRow[] {
  return [
    {
      id: 'fixtureAAAA',
      title: 'Fixture plan summary',
      trigger: JSON.stringify({ type: 'user', source: 'new-tab' }),
      status: 'idle',
      readAt: 1767312100,
      createdAt: 1767312000,
      updatedAt: 1767312100,
      permissionMode: 'full-access',
      model: JSON.stringify({
        provider: 'claude-code',
        modelId: 'claude-sonnet-5',
        thinkingLevel: 'high',
      }),
      runtimeConfig: JSON.stringify({
        proactiveMode: false,
        finalConfirm: true,
        workingDirs: [],
      }),
    },
    {
      id: 'fixtureBBBB',
      title: 'Subagent fan-out',
      trigger: JSON.stringify({ type: 'user', source: 'sidepanel' }),
      status: 'running',
      // read_at behind updated_at: the browser would show an unread dot.
      readAt: 1767398400,
      createdAt: 1767398400,
      updatedAt: 1767398500,
      permissionMode: 'guard',
    },
    {
      // A CLI/bridge session: no trigger, the daemon's placeholder title,
      // and ephemeral. This is the row the old filter dropped.
      id: 'fixtureCCCC',
      title: 'Aside CLI',
      trigger: null,
      ephemeral: 1,
      status: 'idle',
      readAt: 1767484900,
      createdAt: 1767484800,
      updatedAt: 1767484900,
      permissionMode: 'read-only',
    },
    {
      id: 'subagentKid',
      title: 'Audit the config loader',
      // `toolCallId` is the join back to the parent's spawn step; the live
      // table always carries it on a subagent trigger.
      trigger: JSON.stringify({
        type: 'subagent',
        toolCallId: 'toolu_spawn_one',
      }),
      parentId: 'fixtureBBBB',
      status: 'running',
      model: JSON.stringify({
        provider: 'claude-code',
        modelId: 'claude-sonnet-5',
        thinkingLevel: 'medium',
      }),
      createdAt: 1767398401,
      updatedAt: 1767398450,
    },
    {
      id: 'archivedOne',
      title: 'Archived work',
      archivedAt: 1767300000,
      updatedAt: 1767300000,
    },
    {
      id: 'incognitoOne',
      title: 'Incognito',
      incognito: 1,
      updatedAt: 1767399000,
    },
  ];
}

/** Keys consumed by the rig itself rather than written into config.json. */
function stripInternal(overrides: Record<string, unknown>): Record<string, unknown> {
  const { __stateRows, ...rest } = overrides;
  void __stateRows;
  return rest;
}

export function makeTestEnv(
  overrides: Record<string, unknown> = {},
): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-test-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.cpSync(FIXTURE_SESSIONS, sessionsDir, { recursive: true });

  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        token: FAKE_BOT_TOKEN,
        chat_id: OWNER_ID,
        default_model: 'claude-sonnet-5',
        default_effort: 'high',
        model_aliases: {
          sonnet: 'claude-sonnet-5',
          fable: 'claude-fable-5',
          opus: 'claude-opus-4-8',
        },
        sessions_dir: sessionsDir,
        aside_cli: '/bin/echo',
        exec_timeout_seconds: 30,
        ...stripInternal(overrides),
      },
      null,
      2,
    ),
  );

  const secretPath = path.join(root, 'miniapp-secret.json');
  // Pointed at a fixture, never the owner's real database. Without this the
  // list endpoint would read live sessions during a test run.
  const stateDbPath = makeStateDb(
    path.join(root, 'state.db'),
    (overrides.__stateRows as FixtureSessionRow[]) || defaultFixtureRows(),
  );
  const uploadsDir = path.join(root, 'uploads');
  const mediaDir = path.join(root, 'media');

  process.env.MINIAPP_CONFIG = configPath;
  process.env.MINIAPP_SESSIONS_DIR = sessionsDir;
  process.env.MINIAPP_SECRET_PATH = secretPath;
  process.env.MINIAPP_STATE_DB = stateDbPath;
  process.env.MINIAPP_UPLOADS_DIR = uploadsDir;
  process.env.MINIAPP_MEDIA_DIR = mediaDir;

  return {
    root,
    configPath,
    sessionsDir,
    secretPath,
    stateDbPath,
    uploadsDir,
    mediaDir,
    cleanup: () => {
      delete process.env.MINIAPP_CONFIG;
      delete process.env.MINIAPP_SESSIONS_DIR;
      delete process.env.MINIAPP_SECRET_PATH;
      delete process.env.MINIAPP_STATE_DB;
      delete process.env.MINIAPP_UPLOADS_DIR;
      delete process.env.MINIAPP_MEDIA_DIR;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function readFixture(name: string): string {
  return fs.readFileSync(
    path.join(FIXTURE_SESSIONS, name, 'messages.jsonl'),
    'utf8',
  );
}
