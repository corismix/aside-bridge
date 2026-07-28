import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isValidSessionId,
  listSessions,
  resolveSessionDir,
  scanTranscript,
  sessionMsgFile,
} from '../src/sessions.js';
import { makeTestEnv, readFixture, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
  // deterministic recency: CCCC newest, then BBBB, AAAA, DDDD, subagentKid
  const order: Array<[string, number]> = [
    ['2026-01-03_subagentKid', 1_767_000_000],
    ['2026-01-06_fixtureDDDD', 1_767_100_000],
    ['2026-01-02_fixtureAAAA', 1_767_312_000],
    ['2026-01-03_fixtureBBBB', 1_767_398_400],
    ['2026-01-04_fixtureCCCC', 1_767_484_800],
  ];
  for (const [name, seconds] of order) {
    const file = path.join(env.sessionsDir, name, 'messages.jsonl');
    fs.utimesSync(file, seconds, seconds);
    fs.utimesSync(path.join(env.sessionsDir, name), seconds, seconds);
  }
});

afterEach(() => env.cleanup());

describe('session listing', () => {
  it('lists sessions newest first with titles, previews and usage', () => {
    const sessions = listSessions(env.sessionsDir);
    expect(sessions.map((s) => s.id)).toEqual([
      'fixtureCCCC',
      'fixtureBBBB',
      'fixtureAAAA',
      'fixtureDDDD',
      'subagentKid',
    ]);

    const aaaa = sessions.find((s) => s.id === 'fixtureAAAA')!;
    expect(aaaa.date).toBe('2026-01-02');
    expect(aaaa.title).toBe('Summarize the fixture plan');
    expect(aaaa.preview).toContain('fixture summary');
    expect(aaaa.turns).toBe(1);
    expect(aaaa.lastTotalTokens).toBe(1500);
    expect(aaaa.totalCost).toBeCloseTo(0.012, 6);
  });

  it('skips the identical persona seed when deriving a title', () => {
    const cccc = listSessions(env.sessionsDir).find(
      (s) => s.id === 'fixtureCCCC',
    )!;
    // first user message is the persona seed; the real one wins, and the
    // trailing "[bridge note ...]" is trimmed off
    expect(cccc.title).toBe("what's on my plate today");
    expect(cccc.turns).toBe(2);
  });

  it('honours the limit', () => {
    expect(listSessions(env.sessionsDir, 2).map((s) => s.id)).toEqual([
      'fixtureCCCC',
      'fixtureBBBB',
    ]);
  });

  it('ignores directories without a transcript', () => {
    fs.mkdirSync(path.join(env.sessionsDir, '2026-01-05_emptyDDDD'));
    expect(listSessions(env.sessionsDir).map((s) => s.id)).not.toContain(
      'emptyDDDD',
    );
  });

  it('returns an empty list for a missing sessions dir', () => {
    expect(listSessions(path.join(env.root, 'nope'))).toEqual([]);
  });

  it('reflects new activity rather than serving a stale cache', () => {
    const file = path.join(
      env.sessionsDir,
      '2026-01-02_fixtureAAAA',
      'messages.jsonl',
    );
    expect(listSessions(env.sessionsDir)[2].turns).toBe(1);
    fs.appendFileSync(
      file,
      `${JSON.stringify({ role: 'user', content: 'and one more', timestamp: 1767312100 })}\n`,
    );
    const again = listSessions(env.sessionsDir).find(
      (s) => s.id === 'fixtureAAAA',
    )!;
    expect(again.turns).toBe(2);
  });
});

describe('session resolution', () => {
  it('resolves the short id to its dated directory', () => {
    const dir = resolveSessionDir(env.sessionsDir, 'fixtureAAAA');
    expect(dir && path.basename(dir)).toBe('2026-01-02_fixtureAAAA');
    expect(sessionMsgFile(env.sessionsDir, 'fixtureAAAA')).toContain(
      'messages.jsonl',
    );
  });

  it('refuses ids that are not opaque session tokens', () => {
    expect(isValidSessionId('../../etc')).toBe(false);
    expect(isValidSessionId('has space')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('fixtureAAAA')).toBe(true);
    expect(resolveSessionDir(env.sessionsDir, '../../etc')).toBeNull();
  });

  it('returns null for an unknown session', () => {
    expect(resolveSessionDir(env.sessionsDir, 'nosuchsession')).toBeNull();
    expect(sessionMsgFile(env.sessionsDir, 'nosuchsession')).toBeNull();
  });
});

describe('transcript scan', () => {
  it('falls back to a placeholder title when there is no user text', () => {
    const scanned = scanTranscript('');
    expect(scanned.title).toBe('(no messages)');
    expect(scanned.turns).toBe(0);
  });

  it('ignores corrupt lines while scanning', () => {
    const buffer = `not json\n${readFixture('2026-01-02_fixtureAAAA')}`;
    expect(scanTranscript(buffer).turns).toBe(1);
  });
});
