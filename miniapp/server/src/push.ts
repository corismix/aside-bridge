/** Standard Web Push storage and delivery for the standalone PWA. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

interface StoredSubscription extends PushSubscriptionInput {
  createdAt: number;
  updatedAt: number;
}

interface PushState {
  publicKey: string;
  privateKey: string;
  subscriptions: StoredSubscription[];
}

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function defaultPushPath(stateDir: string): string {
  return path.join(stateDir, 'pwa-push.json');
}

function validSubscription(value: unknown): value is PushSubscriptionInput {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const keys = item.keys as Record<string, unknown> | undefined;
  return (
    typeof item.endpoint === 'string' &&
    item.endpoint.startsWith('https://') &&
    item.endpoint.length <= 2048 &&
    !!keys &&
    typeof keys.p256dh === 'string' &&
    typeof keys.auth === 'string' &&
    keys.p256dh.length <= 512 &&
    keys.auth.length <= 512
  );
}

export class PushStore {
  private state: PushState;

  constructor(private readonly file: string) {
    this.state = this.load();
    webpush.setVapidDetails(
      'mailto:aside-pwa@localhost.invalid',
      this.state.publicKey,
      this.state.privateKey,
    );
  }

  private load(): PushState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PushState;
      if (raw.publicKey && raw.privateKey && Array.isArray(raw.subscriptions)) {
        return raw;
      }
    } catch {
      // First run or an interrupted write: generate a fresh local identity.
    }
    const keys = webpush.generateVAPIDKeys();
    const state = { ...keys, subscriptions: [] } satisfies PushState;
    writePrivate(this.file, state);
    return state;
  }

  publicKey(): string {
    return this.state.publicKey;
  }

  save(subscription: unknown): boolean {
    if (!validSubscription(subscription)) return false;
    const now = Date.now();
    const existing = this.state.subscriptions.find(
      (item) => item.endpoint === subscription.endpoint,
    );
    if (existing) {
      Object.assign(existing, subscription, { updatedAt: now });
    } else {
      this.state.subscriptions.push({ ...subscription, createdAt: now, updatedAt: now });
    }
    // The app is single-owner, but an old phone/browser should not grow this
    // file forever if devices are repeatedly reinstalled.
    this.state.subscriptions = this.state.subscriptions.slice(-8);
    writePrivate(this.file, this.state);
    return true;
  }

  remove(endpoint: string): void {
    this.state.subscriptions = this.state.subscriptions.filter(
      (item) => item.endpoint !== endpoint,
    );
    writePrivate(this.file, this.state);
  }

  async notify(input: {
    sessionId: string;
    kind: 'complete' | 'attention';
  }): Promise<void> {
    const payload = JSON.stringify({
      title: 'Aside',
      body: input.kind === 'attention'
        ? 'Aside needs your attention.'
        : 'Aside finished a task.',
      sessionId: input.sessionId,
      kind: input.kind,
    });
    await Promise.all(this.state.subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 300 });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) this.remove(subscription.endpoint);
      }
    }));
  }
}

export function subscriptionId(subscription: PushSubscriptionInput): string {
  return crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
}
