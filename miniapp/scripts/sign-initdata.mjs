/**
 * Hand-rolled Telegram initData signer, per the Mini Apps spec:
 *
 *   secret_key = HMAC_SHA256(bot_token, "WebAppData")
 *   dcs        = every field except `hash`/`signature`, "k=v", sorted by
 *                key, joined with "\n"
 *   hash       = hex(HMAC_SHA256(dcs, secret_key))
 *
 * Deliberately independent of the validator the server uses, so the tests
 * that pair them actually prove interoperability instead of proving a
 * library agrees with itself.
 *
 * Used by dev-initdata.mjs and by the server test-suite. It signs; it never
 * prints or returns the bot token.
 */
import crypto from 'node:crypto';

export function dataCheckString(fields) {
  return Object.entries(fields)
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function signInitData(fields, botToken) {
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString(fields))
    .digest('hex');

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'hash' || value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  params.set('hash', hash);
  return params.toString();
}

/**
 * Build a plausible launch payload for either platform.
 *  - desktop menu button: has query_id
 *  - iOS menu button: no query_id, but chat_instance + chat_type
 */
export function buildInitDataFields({
  userId,
  firstName = 'Owner',
  username,
  platform = 'desktop',
  authDate = Math.floor(Date.now() / 1000),
}) {
  const user = JSON.stringify({
    id: userId,
    first_name: firstName,
    ...(username ? { username } : {}),
    language_code: 'en',
    allows_write_to_pm: true,
  });

  const fields = { user, auth_date: authDate };
  if (platform === 'ios') {
    fields.chat_instance = '-1234567890123456789';
    fields.chat_type = 'sender';
  } else {
    fields.query_id = 'AAEdFixtureQueryId';
  }
  return fields;
}
