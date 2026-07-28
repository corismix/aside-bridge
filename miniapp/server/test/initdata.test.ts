import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper shared with the dev harness
import { buildInitDataFields, signInitData } from '../../scripts/sign-initdata.mjs';
import { InitDataError, validateInitData } from '../src/initdata.js';
import { FAKE_BOT_TOKEN, OWNER_ID } from './helpers.js';

function sign(opts: Parameters<typeof buildInitDataFields>[0]): string {
  return signInitData(buildInitDataFields(opts), FAKE_BOT_TOKEN);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof InitDataError ? err.code : `unexpected:${err}`;
  }
  return 'no_error';
}

describe('initData validation', () => {
  it('accepts a desktop launch (query_id present)', () => {
    const raw = sign({ userId: OWNER_ID, platform: 'desktop' });
    const result = validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID);
    expect(result.user.id).toBe(OWNER_ID);
    expect(result.fields).toContain('query_id');
  });

  it('accepts an iOS menu-button launch (no query_id, chat_instance present)', () => {
    const raw = sign({ userId: OWNER_ID, platform: 'ios' });
    const result = validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID);
    expect(result.user.id).toBe(OWNER_ID);
    expect(result.fields).not.toContain('query_id');
    expect(result.fields).toContain('chat_instance');
    expect(result.fields).toContain('chat_type');
  });

  it('accepts an unknown future field without special-casing it', () => {
    const fields = {
      ...buildInitDataFields({ userId: OWNER_ID, platform: 'ios' }),
      some_future_field: 'whatever',
    };
    const raw = signInitData(fields, FAKE_BOT_TOKEN);
    expect(validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID).user.id).toBe(
      OWNER_ID,
    );
  });

  it('rejects a tampered hash', () => {
    const raw = sign({ userId: OWNER_ID });
    const params = new URLSearchParams(raw);
    const hash = params.get('hash')!;
    params.set('hash', `${hash.slice(0, -1)}${hash.endsWith('a') ? 'b' : 'a'}`);
    expect(codeOf(() =>
      validateInitData(params.toString(), FAKE_BOT_TOKEN, OWNER_ID),
    )).toBe('bad_signature');
  });

  it('rejects tampered payload fields under an intact hash', () => {
    const raw = sign({ userId: OWNER_ID });
    const params = new URLSearchParams(raw);
    params.set('user', JSON.stringify({ id: OWNER_ID, first_name: 'Mallory' }));
    expect(codeOf(() =>
      validateInitData(params.toString(), FAKE_BOT_TOKEN, OWNER_ID),
    )).toBe('bad_signature');
  });

  it('rejects a signature made with a different bot token', () => {
    const raw = signInitData(
      buildInitDataFields({ userId: OWNER_ID }),
      '999:SOME-OTHER-TOKEN',
    );
    expect(codeOf(() => validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID))).toBe(
      'bad_signature',
    );
  });

  it('rejects an auth_date older than 15 minutes', () => {
    const raw = sign({
      userId: OWNER_ID,
      authDate: Math.floor(Date.now() / 1000) - 16 * 60,
    });
    expect(codeOf(() => validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID))).toBe(
      'expired',
    );
  });

  it('accepts an auth_date just inside the window', () => {
    const raw = sign({
      userId: OWNER_ID,
      authDate: Math.floor(Date.now() / 1000) - 14 * 60,
    });
    expect(validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID).user.id).toBe(
      OWNER_ID,
    );
  });

  it('rejects a validly signed launch from a different user', () => {
    const raw = sign({ userId: OWNER_ID + 1 });
    expect(codeOf(() => validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID))).toBe(
      'forbidden_user',
    );
  });

  it('rejects payloads with no hash and empty input', () => {
    const fields = buildInitDataFields({ userId: OWNER_ID });
    const noHash = new URLSearchParams(
      Object.entries(fields).map(
        ([k, v]) => [k, String(v)] as [string, string],
      ),
    ).toString();
    expect(codeOf(() => validateInitData(noHash, FAKE_BOT_TOKEN, OWNER_ID))).toBe(
      'missing_hash',
    );
    expect(codeOf(() => validateInitData('', FAKE_BOT_TOKEN, OWNER_ID))).toBe(
      'malformed',
    );
  });

  it('rejects a signed payload that carries no user object', () => {
    const raw = signInitData(
      { auth_date: Math.floor(Date.now() / 1000), query_id: 'AAE' },
      FAKE_BOT_TOKEN,
    );
    expect(codeOf(() => validateInitData(raw, FAKE_BOT_TOKEN, OWNER_ID))).toBe(
      'no_user',
    );
  });
});
