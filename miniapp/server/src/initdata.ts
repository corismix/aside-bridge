/**
 * Telegram Mini App initData validation.
 *
 * Signature checking is delegated to @telegram-apps/init-data-node, which
 * implements the spec:
 *   secret_key      = HMAC_SHA256(bot_token, "WebAppData")
 *   data_check_str  = every present field except `hash` (and `signature`,
 *                     which is the third-party Ed25519 field), sorted
 *                     alphabetically by key, joined with "\n" as "k=v"
 *   valid           = hex(HMAC_SHA256(data_check_str, secret_key)) === hash
 *
 * Field sets differ per platform -- iOS menu-button launches omit
 * `query_id` and add `chat_instance`/`chat_type`, desktop includes
 * `query_id` -- so nothing here assumes a fixed set. Whatever fields
 * arrived get sorted and hashed.
 *
 * We parse the `user` field ourselves rather than leaning on the library's
 * schema, so an unexpected extra field from a future Telegram client can
 * never turn a cryptographically valid launch into a 401.
 */
import {
  isExpiredError,
  isSignatureMissingError,
  validate,
} from '@telegram-apps/init-data-node';

export type InitDataFailure =
  | 'malformed'
  | 'missing_hash'
  | 'bad_signature'
  | 'expired'
  | 'no_user'
  | 'forbidden_user';

export class InitDataError extends Error {
  constructor(
    readonly code: InitDataFailure,
    message?: string,
  ) {
    super(message || code);
    this.name = 'InitDataError';
  }
}

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export interface ValidatedInitData {
  user: TelegramUser;
  authDate: number;
  /** Platform-variant fields that were actually present, for diagnostics. */
  fields: string[];
}

export const MAX_AUTH_AGE_SECONDS = 15 * 60;

/**
 * Validate a raw initData query string and confirm it belongs to the one
 * allowlisted owner. Throws InitDataError on every rejection path.
 */
export function validateInitData(
  initDataRaw: string,
  botToken: string,
  allowedUserId: number,
  opts: { maxAgeSeconds?: number } = {},
): ValidatedInitData {
  if (typeof initDataRaw !== 'string' || !initDataRaw.trim()) {
    throw new InitDataError('malformed', 'initDataRaw missing or empty');
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initDataRaw);
  } catch {
    throw new InitDataError('malformed', 'initDataRaw is not a query string');
  }

  if (!params.get('hash')) {
    throw new InitDataError('missing_hash', 'initData has no hash field');
  }

  try {
    validate(initDataRaw, botToken, {
      expiresIn: opts.maxAgeSeconds ?? MAX_AUTH_AGE_SECONDS,
    });
  } catch (err) {
    if (isExpiredError(err)) {
      throw new InitDataError('expired', 'initData auth_date is too old');
    }
    if (isSignatureMissingError(err)) {
      throw new InitDataError('missing_hash', 'initData has no hash field');
    }
    // TypeError here means a missing/non-integer auth_date, which we treat
    // as an untrustworthy payload rather than a distinct client error.
    throw new InitDataError('bad_signature', 'initData signature mismatch');
  }

  const authDate = Number(params.get('auth_date') || 0);

  let user: TelegramUser | null = null;
  try {
    user = JSON.parse(params.get('user') || 'null') as TelegramUser | null;
  } catch {
    throw new InitDataError('no_user', 'initData user field is not JSON');
  }
  if (!user || typeof user.id !== 'number') {
    throw new InitDataError('no_user', 'initData user has no numeric id');
  }

  if (user.id !== allowedUserId) {
    throw new InitDataError(
      'forbidden_user',
      'user is not the allowlisted owner',
    );
  }

  return { user, authDate, fields: [...params.keys()].sort() };
}
