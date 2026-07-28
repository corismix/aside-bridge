/**
 * Session tokens. A validated initData launch mints a 24h HS256 JWT; every
 * other REST route and the WebSocket require it.
 */
import jwt from 'jsonwebtoken';

export const TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface SessionClaims {
  sub: string;
  uid: number;
  name?: string;
}

export function mintToken(
  secret: string,
  claims: SessionClaims,
  ttlSeconds = TOKEN_TTL_SECONDS,
): string {
  return jwt.sign({ uid: claims.uid, name: claims.name }, secret, {
    algorithm: 'HS256',
    subject: claims.sub,
    expiresIn: ttlSeconds,
  });
}

export type TokenFailure = 'missing' | 'invalid' | 'expired' | 'forbidden';

export class TokenError extends Error {
  constructor(readonly code: TokenFailure) {
    super(code);
    this.name = 'TokenError';
  }
}

/**
 * Verify a bearer token and re-check the allowlist, so revoking the owner
 * id in config takes effect without waiting for tokens to expire.
 */
export function verifyToken(
  token: string | undefined,
  secret: string,
  allowedUserId: number,
): SessionClaims {
  if (!token) throw new TokenError('missing');
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as
      jwt.JwtPayload;
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      throw new TokenError('expired');
    }
    throw new TokenError('invalid');
  }
  const uid = Number(payload.uid);
  if (!Number.isFinite(uid)) throw new TokenError('invalid');
  if (uid !== allowedUserId) throw new TokenError('forbidden');
  return { sub: String(payload.sub || uid), uid, name: payload.name as string };
}

/** Pull a bearer token out of an Authorization header. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}
