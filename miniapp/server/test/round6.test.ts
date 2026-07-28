/**
 * Round 6: the local-image file route, and unique subagent colours.
 *
 * Both bugs here were reported off a live run rather than found by
 * reading, and both have a guard worth pinning:
 *
 *  - The file route is a NEW way to name a path on the owner's machine.
 *    It reuses the artifact route's containment rules, so it reuses the
 *    artifact route's attack strings too, plus the ones that only apply
 *    here (an absolute path outside every root, a symlink out of a root,
 *    a non-image extension, an oversized file).
 *  - Creature colours were hashed from the spawn id, which collided. The
 *    test is the property that matters: N spawns, N distinct colours, and
 *    the same answer on a second build of the same transcript.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper shared with the dev harness
import { buildInitDataFields, signInitData } from '../../scripts/sign-initdata.mjs';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import {
  FAKE_BOT_TOKEN,
  OWNER_ID,
  defaultFixtureRows,
  makeTestEnv,
  type TestEnv,
} from './helpers.js';
import { fileURLToPath } from 'node:url';
import {
  MAX_LOCAL_IMAGE_BYTES,
  localFileRoots,
  localFileStatus,
  localImageContentType,
  resolveLocalFile,
} from '../src/localfiles.js';
import {
  SUBAGENT_PALETTE_SIZE,
  attachChildren,
  buildThread,
  workSteps,
  type ChildSession,
} from '../src/thread.js';
import { readHistory } from '../src/jsonl.js';

/** The parent that fans out ten subagents and ends with an image answer. */
const EEEE = {
  id: 'fixtureEEEE',
  title: 'Ten-way fan-out',
  trigger: JSON.stringify({ type: 'user', source: 'sidepanel' }),
  status: 'idle',
  readAt: 1767744100,
  createdAt: 1767744000,
  updatedAt: 1767744050,
  permissionMode: 'guard',
};

let env: TestEnv;
let app: FastifyInstance;
let token: string;

/**
 * Copied in here rather than added to the shared fixture directory: the
 * session-listing tests assert an exact, ordered list of the sessions that
 * directory holds, and a sixth one would be a change to their subject
 * rather than to this file's.
 */
const ROUND6_FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'round6',
);

const sessionDir = () => path.join(env.sessionsDir, '2026-01-07_fixtureEEEE');
const shot = () => path.join(sessionDir(), 'artifacts/2026-01-07/shot.png');

beforeEach(async () => {
  env = makeTestEnv({ __stateRows: [...defaultFixtureRows(), EEEE] });
  fs.cpSync(ROUND6_FIXTURES, env.sessionsDir, { recursive: true });
  const config = loadConfig();
  const built = await buildServer(config, {
    jwtSecret: loadOrCreateJwtSecret(env.secretPath),
  });
  app = built.app;
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth',
    payload: {
      initDataRaw: signInitData(
        buildInitDataFields({ userId: OWNER_ID, platform: 'ios' }),
        FAKE_BOT_TOKEN,
      ),
    },
  });
  token = res.json().token;
});

afterEach(async () => {
  await app.close();
  env.cleanup();
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const fileUrl = (id: string, p: string) =>
  `/api/sessions/${id}/file?path=${encodeURIComponent(p)}`;

describe('the local image file route', () => {
  it('serves an image that lives under the session directory', async () => {
    const res = await get(fileUrl('fixtureEEEE', shot()));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // Same posture as the artifact route: never markup for our own origin.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('serves from the uploads and media roots too', async () => {
    for (const root of [env.uploadsDir, env.mediaDir]) {
      fs.mkdirSync(root, { recursive: true });
      const target = path.join(root, 'photo.jpg');
      fs.copyFileSync(shot(), target);
      const res = await get(fileUrl('fixtureEEEE', target));
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
    }
  });

  /**
   * The artifact route's attack strings, plus the ones only an absolute
   * path can express. Every one of these must be a refusal, never a read.
   */
  it('refuses every containment attack', async () => {
    const attacks = [
      '',
      '.',
      '..',
      '../messages.jsonl',
      '../../../../etc/hosts',
      '/etc/hosts',
      '/etc/passwd',
      // Absolute, inside the sessions root, but a different session.
      path.join(env.sessionsDir, '2026-01-02_fixtureAAAA/messages.jsonl'),
      // Absolute, image-looking, but nowhere near a root.
      '/tmp/not-a-root/shot.png',
      // Inside a root by string, escaping by traversal.
      path.join(sessionDir(), 'artifacts/../../2026-01-02_fixtureAAAA/x.png'),
      // The config itself, which carries the bot token.
      env.configPath,
      env.secretPath,
      'artifacts/2026-01-07/shot.png', // relative: not this route's job
      '~/artifacts/2026-01-07/shot.png',
      `${shot()}\0.png`,
    ];
    for (const attack of attacks) {
      const res = await get(fileUrl('fixtureEEEE', attack));
      expect(
        res.statusCode,
        `expected a refusal for ${JSON.stringify(attack)}`,
      ).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain(FAKE_BOT_TOKEN);
    }
  });

  it('refuses a symlink that escapes a root, even though it looks inside', async () => {
    const link = path.join(sessionDir(), 'artifacts/2026-01-07/escape.png');
    fs.symlinkSync(env.configPath, link);
    const res = await get(fileUrl('fixtureEEEE', link));
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(FAKE_BOT_TOKEN);
  });

  it('refuses a non-image even inside an allowed root', async () => {
    const inside = path.join(sessionDir(), 'messages.jsonl');
    const res = await get(fileUrl('fixtureEEEE', inside));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('unsupported_type');
  });

  it('caps the served size at 10 MB', () => {
    expect(MAX_LOCAL_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    const roots = localFileRoots({
      sessionDir: sessionDir(),
      uploadsDir: env.uploadsDir,
      mediaDir: env.mediaDir,
    });
    // Same file, a cap it cannot fit under: the only difference is the cap.
    expect(resolveLocalFile(roots, shot(), 10_000_000).ok).toBe(true);
    const tight = resolveLocalFile(roots, shot(), 1);
    expect(tight.ok).toBe(false);
    expect(tight.ok === false && tight.reason).toBe('file_too_large');
    expect(localFileStatus('file_too_large')).toBe(413);
  });

  it('is behind the same auth as everything else', async () => {
    const noToken = await app.inject({
      method: 'GET',
      url: fileUrl('fixtureEEEE', shot()),
    });
    expect(noToken.statusCode).toBe(401);

    const badToken = await app.inject({
      method: 'GET',
      url: `${fileUrl('fixtureEEEE', shot())}&token=nope`,
    });
    expect(badToken.statusCode).toBe(401);

    // A query token works, because an <img> tag cannot set a header.
    const viaQuery = await app.inject({
      method: 'GET',
      url: `${fileUrl('fixtureEEEE', shot())}&token=${token}`,
    });
    expect(viaQuery.statusCode).toBe(200);
  });

  it('404s an unknown session and 400s a malformed id', async () => {
    expect((await get(fileUrl('nosuchsession', shot()))).statusCode).toBe(404);
    expect((await get(fileUrl('bad%2Fid', shot()))).statusCode).toBe(400);
  });

  it('names only image types', () => {
    expect(localImageContentType('a.png')).toBe('image/png');
    expect(localImageContentType('a.JPG')).toBe('image/jpeg');
    expect(localImageContentType('a.webp')).toBe('image/webp');
    expect(localImageContentType('a.md')).toBeNull();
    expect(localImageContentType('a.jsonl')).toBeNull();
    expect(localImageContentType('a')).toBeNull();
  });

  it('drops a root that does not exist rather than comparing strings', () => {
    const roots = localFileRoots({
      sessionDir: sessionDir(),
      uploadsDir: path.join(env.root, 'never-created'),
      mediaDir: path.join(env.root, 'also-not-there'),
    });
    expect(roots).toHaveLength(1);
    expect(resolveLocalFile(roots, shot()).ok).toBe(true);
  });
});

describe('subagent creature colours', () => {
  const items = () =>
    buildThread(readHistory(path.join(sessionDir(), 'messages.jsonl')));

  it('gives ten spawns ten different palette slots, wrapping past eight', () => {
    const spawns = workSteps(items())
      .map((step) => step.subagent)
      .filter((spawn): spawn is NonNullable<typeof spawn> => Boolean(spawn));
    expect(spawns).toHaveLength(10);

    // The first PALETTE_SIZE are all distinct -- the property the old hash
    // could not promise.
    const firstRound = spawns.slice(0, SUBAGENT_PALETTE_SIZE).map((s) => s.hue);
    expect(new Set(firstRound).size).toBe(SUBAGENT_PALETTE_SIZE);
    expect(firstRound).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Past the palette it wraps, in order, rather than jumping around.
    expect(spawns.slice(SUBAGENT_PALETTE_SIZE).map((s) => s.hue)).toEqual([0, 1]);
  });

  it('gives the same slots on a second build of the same thread', () => {
    const hues = (built: ReturnType<typeof items>) =>
      workSteps(built)
        .filter((step) => step.subagent)
        .map((step) => step.subagent!.hue);
    expect(hues(items())).toEqual(hues(items()));
  });

  it('hands the child session the slot of the spawn that created it', () => {
    const built = items();
    const children: ChildSession[] = [
      {
        id: 'kid-3',
        title: 'Worker 3',
        status: 'idle',
        toolCallId: 'toolu_spawn_03',
        modelLabel: null,
        running: false,
      },
      {
        id: 'kid-1',
        title: 'Worker 1',
        status: 'running',
        toolCallId: 'toolu_spawn_01',
        modelLabel: null,
        running: true,
      },
    ];
    const annotated = attachChildren(built, children);
    // Slot follows the SPAWN order, not the order the daemon listed them.
    expect(annotated.map((c) => [c.id, c.hue])).toEqual([
      ['kid-3', 2],
      ['kid-1', 0],
    ]);
    const spawn = workSteps(built).find(
      (step) => step.subagent?.callId === 'toolu_spawn_01',
    )!.subagent!;
    expect(spawn.child?.id).toBe('kid-1');
    expect(spawn.hue).toBe(0);
  });

  it('still gives a slot to a child whose spawn is not in the transcript', () => {
    const annotated = attachChildren(items(), [
      {
        id: 'orphan',
        title: 'Compacted away',
        status: 'idle',
        toolCallId: 'toolu_gone',
        modelLabel: null,
        running: false,
      },
    ]);
    expect(annotated[0].hue).toBeTypeOf('number');
  });

  it('ships the slots to the client on the thread response', async () => {
    const body = (await get('/api/sessions/fixtureEEEE/thread')).json();
    const hues = body.items
      .flatMap((item: { kind: string; items?: Array<{ subagent?: { hue: number } }> }) =>
        item.kind === 'work' ? (item.items ?? []) : [],
      )
      .filter((step: { subagent?: unknown }) => step.subagent)
      .map((step: { subagent: { hue: number } }) => step.subagent.hue);
    expect(hues.slice(0, SUBAGENT_PALETTE_SIZE)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
