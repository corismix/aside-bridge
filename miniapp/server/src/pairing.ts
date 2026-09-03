/** One-use local pairing codes for the standalone PWA. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

interface PairingRecord {
  hash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}

function digest(code: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(code).digest();
}

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function defaultPairingPath(stateDir: string): string {
  return path.join(stateDir, 'pwa-pairing.json');
}

export class PairingStore {
  constructor(
    private readonly file: string,
    private readonly secret: string,
  ) {}

  create(now = Date.now()): string {
    const code = crypto.randomBytes(10).toString('hex').toUpperCase();
    writePrivate(this.file, {
      hash: digest(code, this.secret).toString('hex'),
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
    } satisfies PairingRecord);
    return code;
  }

  consume(raw: string, now = Date.now()): boolean {
    const code = String(raw || '').trim().replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]{20}$/.test(code)) return false;

    let record: PairingRecord;
    try {
      record = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PairingRecord;
    } catch {
      return false;
    }
    if (
      record.consumedAt ||
      !Number.isFinite(record.expiresAt) ||
      now > record.expiresAt ||
      typeof record.hash !== 'string'
    ) return false;

    const actual = digest(code, this.secret);
    const expected = Buffer.from(record.hash, 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(actual, expected)) {
      return false;
    }
    writePrivate(this.file, { ...record, consumedAt: now });
    return true;
  }
}
