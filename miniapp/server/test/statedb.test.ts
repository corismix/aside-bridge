/**
 * Read-only state.db access.
 *
 * The fixtures here are real SQLite files built with node:sqlite, so the
 * open-mode and query behaviour are exercised for real rather than mocked.
 * Column shapes match the live daemon database: `permission_mode` is a
 * hyphenated string and `model` is a JSON blob, not a bare id.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StateDb,
  UNKNOWN_STATE,
  epochMs,
  isFullAccess,
  parseRuntimeConfig,
  parseSessionModel,
  permissionLabel,
} from '../src/statedb.js';
import { defaultFixtureRows, makeStateDb } from './helpers.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-statedb-'));
  temps.push(dir);
  return dir;
}

function model(provider: string, modelId: string, thinkingLevel = 'high') {
  return JSON.stringify({ provider, modelId, thinkingLevel, fastMode: false });
}

/** Build a database shaped like the daemon's. */
function makeDb(rows: Array<[string, string | null, string | null]>): string {
  const file = path.join(tempDir(), 'state.db');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE sessions (id TEXT, title TEXT, permission_mode TEXT, model TEXT)',
  );
  const insert = db.prepare(
    'INSERT INTO sessions (id, title, permission_mode, model) VALUES (?, ?, ?, ?)',
  );
  for (const [id, permission, modelJson] of rows) {
    insert.run(id, `title ${id}`, permission, modelJson);
  }
  db.close();
  return file;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('node:sqlite open mode', () => {
  /**
   * This is the reason the reader spells the option `readOnly`.
   *
   * node:sqlite silently ignores an unrecognised lowercase `readonly` and
   * hands back a WRITABLE handle -- against the daemon's live database
   * that would be a genuinely dangerous typo, so it is pinned here.
   */
  it('enforces readOnly and silently ignores lowercase readonly', () => {
    const file = makeDb([['a', 'guard', null]]);

    const ro = new DatabaseSync(file, { readOnly: true });
    expect(() => ro.exec("INSERT INTO sessions (id) VALUES ('nope')")).toThrow(
      /readonly/i,
    );
    ro.close();

    const typo = new DatabaseSync(file, { readonly: true } as never);
    expect(() =>
      typo.exec("INSERT INTO sessions (id) VALUES ('written')"),
    ).not.toThrow();
    typo.close();
  });

  it('leaves the database untouched after a StateDb read', async () => {
    const file = makeDb([['a', 'full-access', model('claude-code', 'x')]]);
    const before = fs.readFileSync(file);

    await new StateDb(file, 0).read('a');

    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe('permissionLabel', () => {
  it('humanises the modes the live database actually contains', () => {
    // Live distribution: full-access (139), guard (27), read-only (4).
    expect(permissionLabel('full-access')).toBe('Full access');
    expect(permissionLabel('guard')).toBe('Guard');
    expect(permissionLabel('read-only')).toBe('Read only');
  });

  it('renders an unseen mode as itself rather than mislabelling it', () => {
    expect(permissionLabel('some_new_mode')).toBe('Some new mode');
  });

  it('returns null for absent values so the label can be hidden', () => {
    expect(permissionLabel(null)).toBeNull();
    expect(permissionLabel(undefined)).toBeNull();
    expect(permissionLabel('')).toBeNull();
    expect(permissionLabel('   ')).toBeNull();
  });

  it('flags only full access for the orange treatment', () => {
    expect(isFullAccess('Full access')).toBe(true);
    expect(isFullAccess('Guard')).toBe(false);
    expect(isFullAccess('Read only')).toBe(false);
    expect(isFullAccess(null)).toBe(false);
  });
});

describe('parseSessionModel', () => {
  it('parses the JSON blob the column actually stores', () => {
    expect(parseSessionModel(model('claude-code', 'claude-fable-5'))).toEqual({
      provider: 'claude-code',
      modelId: 'claude-fable-5',
      thinkingLevel: 'high',
    });
  });

  it('returns null for empty, malformed or id-less values', () => {
    expect(parseSessionModel(null)).toBeNull();
    expect(parseSessionModel('')).toBeNull();
    expect(parseSessionModel('not json')).toBeNull();
    expect(parseSessionModel('{"provider":"x"}')).toBeNull();
  });
});

describe('StateDb.read', () => {
  const rows: Array<[string, string | null, string | null]> = [
    ['full-1', 'full-access', model('claude-code', 'claude-fable-5')],
    ['guard-1', 'guard', model('openai-codex', 'gpt-5.5', 'medium')],
    ['readonly-1', 'read-only', null],
    ['nomodel-1', 'guard', ''],
  ];

  it('reads a full-access session with its pinned model', async () => {
    const db = new StateDb(makeDb(rows), 0);
    expect(await db.read('full-1')).toEqual({
      permission: 'Full access',
      permissionMode: 'full-access',
      finalConfirm: null,
      runtimeConfig: null,
      parentId: null,
      model: {
        provider: 'claude-code',
        modelId: 'claude-fable-5',
        thinkingLevel: 'high',
      },
    });
  });

  it('reads a guard session', async () => {
    const db = new StateDb(makeDb(rows), 0);
    const state = await db.read('guard-1');
    expect(state.permission).toBe('Guard');
    expect(state.model?.modelId).toBe('gpt-5.5');
    expect(state.model?.thinkingLevel).toBe('medium');
  });

  it('reports the permission even when no model is pinned', async () => {
    const db = new StateDb(makeDb(rows), 0);
    expect(await db.read('readonly-1')).toEqual({
      permission: 'Read only',
      permissionMode: 'read-only',
      finalConfirm: null,
      runtimeConfig: null,
      parentId: null,
      model: null,
    });
    expect(await db.read('nomodel-1')).toEqual({
      permission: 'Guard',
      permissionMode: 'guard',
      finalConfirm: null,
      runtimeConfig: null,
      parentId: null,
      model: null,
    });
  });

  it('returns unknown for a missing row rather than guessing', async () => {
    const db = new StateDb(makeDb(rows), 0);
    expect(await db.read('does-not-exist')).toEqual(UNKNOWN_STATE);
  });

  it('returns unknown for a missing database file', async () => {
    const db = new StateDb(path.join(tempDir(), 'absent.db'), 0);
    expect(await db.read('full-1')).toEqual(UNKNOWN_STATE);
  });

  it('returns unknown for a corrupt / non-sqlite file', async () => {
    const file = path.join(tempDir(), 'garbage.db');
    fs.writeFileSync(file, 'this is not a database');
    const db = new StateDb(file, 0);
    expect(await db.read('full-1')).toEqual(UNKNOWN_STATE);
  });

  it('returns unknown when the table or columns are absent', async () => {
    const file = path.join(tempDir(), 'other.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE unrelated (x TEXT)');
    raw.close();

    const db = new StateDb(file, 0);
    expect(await db.read('full-1')).toEqual(UNKNOWN_STATE);
  });

  it('caches within the TTL and refetches after it', async () => {
    const file = makeDb([['a', 'guard', null]]);
    let now = 1000;
    const db = new StateDb(file, 5000, () => now);

    expect((await db.read('a')).permission).toBe('Guard');

    // Change the value underneath; the cache should still answer.
    const w = new DatabaseSync(file);
    w.exec("UPDATE sessions SET permission_mode = 'full-access' WHERE id = 'a'");
    w.close();

    expect((await db.read('a')).permission).toBe('Guard');

    now += 6000;
    expect((await db.read('a')).permission).toBe('Full access');
  });
});

/**
 * The session list, which is now sourced from this table rather than from
 * `aside.sessions.list()`.
 *
 * The facade's list is the browser sidepanel's view: on the owner's machine
 * it returns 93 of the 179 rows and drops every CLI-created session --
 * which is where the Telegram bridge's sessions, and the ones this app
 * starts itself, live. Each filter below has a row in the fixture.
 */
describe('StateDb.list', () => {
  const listDb = () =>
    new StateDb(
      makeStateDb(path.join(tempDir(), 'state.db'), defaultFixtureRows()),
      0,
    );

  it('includes browser AND CLI sessions, newest first', async () => {
    const rows = (await listDb().list())!;
    expect(rows.map((r) => r.id)).toEqual([
      'fixtureCCCC',
      'fixtureBBBB',
      'fixtureAAAA',
    ]);
  });

  /**
   * The regression this whole change exists for. A CLI session has no
   * trigger, the placeholder title "Aside CLI", and `ephemeral = 1`; an
   * `ephemeral = 0` filter would drop it and the owner would not see a
   * session they had just started from their phone.
   */
  it('does not drop ephemeral CLI sessions', async () => {
    const rows = (await listDb().list())!;
    const cli = rows.find((r) => r.id === 'fixtureCCCC');
    expect(cli).toBeDefined();
    expect(cli!.ephemeral).toBe(true);
    expect(cli!.trigger).toBeNull();
    expect(cli!.title).toBe('Aside CLI');
  });

  it('hides subagent children, archived and incognito sessions', async () => {
    const ids = (await listDb().list())!.map((r) => r.id);
    expect(ids).not.toContain('subagentKid');
    expect(ids).not.toContain('archivedOne');
    expect(ids).not.toContain('incognitoOne');
  });

  it('converts the table’s unix seconds to milliseconds', async () => {
    const rows = (await listDb().list())!;
    const row = rows.find((r) => r.id === 'fixtureAAAA')!;
    expect(row.updatedAt).toBe(1767312100 * 1000);
    expect(row.createdAt).toBe(1767312000 * 1000);
    expect(row.readAt).toBe(1767312100 * 1000);
  });

  it('exposes read_at vs updated_at so unread can be derived', async () => {
    const rows = (await listDb().list())!;
    const unread = rows.find((r) => r.id === 'fixtureBBBB')!;
    const read = rows.find((r) => r.id === 'fixtureAAAA')!;
    expect(unread.readAt < unread.updatedAt).toBe(true);
    expect(read.readAt < read.updatedAt).toBe(false);
  });

  it('honours the limit', async () => {
    expect((await listDb().list(1))!.map((r) => r.id)).toEqual(['fixtureCCCC']);
  });

  /**
   * null, not [] -- so the caller can tell "the database says there are no
   * sessions" from "there is no database" and fall back to the facade
   * rather than showing an empty screen.
   */
  it('returns null when the database cannot be read', async () => {
    expect(await new StateDb(path.join(tempDir(), 'absent.db'), 0).list()).toBeNull();

    const garbage = path.join(tempDir(), 'garbage.db');
    fs.writeFileSync(garbage, 'not a database');
    expect(await new StateDb(garbage, 0).list()).toBeNull();
  });
});

describe('runtime config + timestamp parsing', () => {
  it('reads finalConfirm and keeps the whole config for merging', async () => {
    const file = makeStateDb(
      path.join(tempDir(), 'state.db'),
      defaultFixtureRows(),
    );
    const state = await new StateDb(file, 0).read('fixtureAAAA');
    expect(state.permissionMode).toBe('full-access');
    expect(state.finalConfirm).toBe(true);
    // The siblings have to survive the read, or a write cannot preserve them.
    expect(state.runtimeConfig).toEqual({
      proactiveMode: false,
      finalConfirm: true,
      workingDirs: [],
    });
  });

  it('reports finalConfirm as null when the config does not carry it', async () => {
    const file = makeStateDb(path.join(tempDir(), 'state.db'), [
      { id: 'bare', runtimeConfig: '{}' },
    ]);
    const state = await new StateDb(file, 0).read('bare');
    expect(state.finalConfirm).toBeNull();
    expect(state.runtimeConfig).toEqual({});
  });

  it('parses runtime_config defensively', () => {
    expect(parseRuntimeConfig('{"a":1}')).toEqual({ a: 1 });
    expect(parseRuntimeConfig('')).toBeNull();
    expect(parseRuntimeConfig('not json')).toBeNull();
    expect(parseRuntimeConfig('[1,2]')).toBeNull();
    expect(parseRuntimeConfig(null)).toBeNull();
  });

  it('treats stored timestamps as seconds unless already ms', () => {
    expect(epochMs(1767312000)).toBe(1767312000000);
    expect(epochMs(1767312000000)).toBe(1767312000000);
    expect(epochMs(0)).toBe(0);
    expect(epochMs(null)).toBe(0);
  });
});
