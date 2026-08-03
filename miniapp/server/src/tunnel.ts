/**
 * Public HTTPS exposure, with no extra tooling for the end user.
 *
 * A Telegram Mini App must be served over HTTPS from a public URL, but the
 * server runs on someone's Mac. Rather than making people set up Tailscale
 * or a Cloudflare account, this downloads the static `cloudflared` binary
 * once and runs a quick tunnel, which needs no account at all.
 *
 * The tradeoff, deliberately taken: a quick tunnel's hostname is ephemeral
 * and changes on every restart. That is why `onUrl` exists and why menu
 * registration is wired to it -- when the hostname rotates, the menu
 * button is pointed at the new one.
 *
 * The binary lives under the bridge's state directory, never in the repo.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { defaultAsideRoot } from './config.js';

/**
 * The pinned release and its vendored digests -- audit finding M-6.
 *
 * Read from disk rather than `import`ed so the file stays plain JSON that
 * a human can diff when the pin moves, and so no import-attribute syntax
 * is needed on the Node versions this supports. The build copies it next
 * to the emitted JS; under vitest `import.meta.url` is the source file, so
 * both resolve to a real path.
 */
export interface PinnedRelease {
  tag: string;
  assets: Record<string, string>;
}

const RELEASE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'cloudflared-release.json',
);

let pinnedCache: PinnedRelease | null = null;

export function pinnedRelease(): PinnedRelease {
  if (!pinnedCache) {
    const raw = JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8')) as PinnedRelease;
    pinnedCache = { tag: String(raw.tag), assets: raw.assets || {} };
  }
  return pinnedCache;
}

function releaseBase(): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${
    pinnedRelease().tag
  }`;
}

/**
 * What to tell someone whose download did not verify.
 *
 * Failing closed is only defensible if there is a way forward that is not
 * "turn the check off", so both escape hatches are named every time.
 */
const BYO_BINARY_HINT =
  'Point the server at a cloudflared you installed yourself instead: set ' +
  'MINIAPP_CLOUDFLARED_PATH=/path/to/cloudflared, or "cloudflared_path" ' +
  'in the miniapp section of config.json (`brew install cloudflared`).';

/** Any trycloudflare hostname the CLI prints as it comes up or rotates. */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

/**
 * Hostnames under trycloudflare.com that are NOT this machine's tunnel.
 *
 * cloudflared talks to `api.trycloudflare.com` to register a quick tunnel
 * and prints that hostname inside its own error text when registration
 * fails -- which is exactly what happens on a laptop that just woke up and
 * has no network yet. The old parser matched it, published it as the public
 * URL, and pushed it to Telegram's menu button. Observed in the wild on
 * 2026-08-02: `tunnel url https://api.trycloudflare.com` immediately
 * followed by `tunnel exited (1)`.
 *
 * A real quick-tunnel hostname is a multi-word hyphenated slug, so a bare
 * single-label host is rejected on both counts: the denylist and the
 * missing hyphen.
 */
const RESERVED_TUNNEL_HOSTS = new Set([
  'api',
  'www',
  'dash',
  'developers',
  'update',
  'protocol-v2',
  'region1',
  'region2',
]);

/** True when `host` looks like a real ephemeral quick-tunnel slug. */
export function isQuickTunnelHost(host: string): boolean {
  const label = String(host || '')
    .replace(/^https:\/\//i, '')
    .replace(/\.trycloudflare\.com\/?$/i, '')
    .toLowerCase();
  if (!label || RESERVED_TUNNEL_HOSTS.has(label)) return false;
  // Quick tunnels are always several words joined by hyphens. Anything
  // without one is infrastructure, not us.
  return label.includes('-');
}

export interface TunnelAsset {
  asset: string;
  /** darwin ships gzipped tarballs; linux ships a bare binary. */
  archive: 'tgz' | 'raw';
}

/**
 * Which release asset this machine needs.
 *
 * Exported so the platform matrix is testable without downloading
 * anything.
 */
export function assetFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TunnelAsset {
  const is64 = arch === 'x64' || arch === 'x86_64';
  if (platform === 'darwin') {
    return {
      asset: is64 ? 'cloudflared-darwin-amd64.tgz' : 'cloudflared-darwin-arm64.tgz',
      archive: 'tgz',
    };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { asset: 'cloudflared-linux-arm64', archive: 'raw' };
    if (arch === 'arm') return { asset: 'cloudflared-linux-arm', archive: 'raw' };
    return { asset: 'cloudflared-linux-amd64', archive: 'raw' };
  }
  if (platform === 'win32') {
    return {
      asset: is64 ? 'cloudflared-windows-amd64.exe' : 'cloudflared-windows-386.exe',
      archive: 'raw',
    };
  }
  // Reached only on genuinely exotic platforms now. Name the two ways
  // forward rather than just refusing: an unsupported tunnel is not the
  // same as an unusable app, since the server still runs locally.
  throw new Error(
    `cloudflared has no build for ${platform}/${arch}. Run with ` +
      'MINIAPP_TUNNEL=none and expose the port yourself, or install ' +
      'cloudflared and set MINIAPP_CLOUDFLARED_PATH.',
  );
}

/**
 * First trycloudflare URL in a chunk of cloudflared output.
 *
 * cloudflared banners the URL inside an ASCII box across several lines, so
 * this scans rather than matching a fixed line shape.
 */
export function parseTunnelUrl(chunk: string): string | null {
  const matches = String(chunk || '').match(URL_RE);
  if (!matches) return null;
  for (const match of matches) {
    const url = match.toLowerCase();
    if (isQuickTunnelHost(url)) return url;
  }
  return null;
}

export interface TunnelOptions {
  port: number;
  /** Directory for the downloaded binary -- outside the repo. */
  binDir: string;
  /** A cloudflared the user installed themselves; skips the download. */
  cloudflaredPath?: string;
  onUrl?: (url: string) => void;
  log?: (message: string) => void;
  /** Injected in tests so no network or process is ever touched. */
  spawnFn?: typeof spawn;
  downloadFn?: (dest: string) => Promise<void>;
  /**
   * How often to probe the PUBLIC url and check for a sleep/wake gap.
   * Defaults to 45s; set to 0 to disable the watchdog entirely.
   */
  healthIntervalMs?: number;
  /** Consecutive probe failures before the tunnel is force-recycled. */
  healthFailureLimit?: number;
  /** Fired every time a probe confirms the public url is reachable. */
  onHealthy?: (url: string) => void;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
}

/**
 * Extra timer lag that means "this machine was asleep", not "this machine
 * was busy".
 *
 * A setInterval does not fire while macOS is suspended, so the first tick
 * after the lid opens arrives late by roughly the sleep duration. 20s of
 * slack is far more than scheduler jitter and far less than any real nap.
 */
const WAKE_DRIFT_MS = 20_000;

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Download to `dest`, but only publish it if the bytes hash to `expected`.
 *
 * The partial file is written under `.part` and hashed there, so a
 * mismatch never leaves anything at the destination path that a later
 * run would mistake for a verified binary.
 */
async function download(
  url: string,
  dest: string,
  expected: string,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(res.body as any, fs.createWriteStream(tmp));

  const actual = sha256File(tmp);
  if (actual !== expected) {
    await fs.promises.rm(tmp, { force: true });
    throw new Error(
      `cloudflared checksum mismatch for ${path.basename(url)}: expected ` +
        `${expected}, got ${actual}. Refusing to run it. ${BYO_BINARY_HINT}`,
    );
  }
  await fs.promises.rename(tmp, dest);
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/**
 * A cloudflared the user installed themselves, or null.
 *
 * The env var wins over config so a one-off run can override an install
 * without editing the file that carries the bot token. Both are checked
 * before anything is downloaded: someone who has already got the binary
 * should never be made to fetch a second copy.
 */
export function userSuppliedCloudflared(
  configured?: string,
): string | null {
  const raw = (process.env.MINIAPP_CLOUDFLARED_PATH || configured || '').trim();
  if (!raw) return null;
  const expanded = raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  if (!fs.existsSync(expanded)) {
    throw new Error(
      `cloudflared_path points at ${expanded}, which does not exist`,
    );
  }
  return expanded;
}

/** Where the verified-download marker for `binDir` lives. */
function markerPath(binDir: string): string {
  return path.join(binDir, 'cloudflared.verified.json');
}

/**
 * Ensure a verified binary exists at `binDir/cloudflared`.
 *
 * Audit finding M-6 was that this downloaded from
 * `releases/latest/download`, chmod 755'd whatever arrived and executed
 * it, with HTTPS to github.com as the only control. Now the release tag
 * is pinned and every asset's SHA-256 is vendored in
 * `cloudflared-release.json`; a mismatch deletes the partial file and
 * throws, and there is no flag to skip the check -- the way past it is to
 * supply your own binary, which is an explicit choice rather than a
 * silent downgrade.
 *
 * An existing binary is reused. When it carries a marker from an older
 * pin the marker is honoured rather than forcing a re-download: the file
 * on disk was verified against the pin that was current when it landed,
 * and silently replacing a working tunnel binary on upgrade is a worse
 * failure mode than running a slightly older cloudflared.
 */
export async function ensureCloudflared(
  binDir: string,
  log: (m: string) => void = () => {},
): Promise<string> {
  const target = path.join(binDir, 'cloudflared');
  const { tag, assets } = pinnedRelease();

  if (fs.existsSync(target)) {
    let verifiedTag = '';
    try {
      verifiedTag = String(
        JSON.parse(fs.readFileSync(markerPath(binDir), 'utf8')).tag || '',
      );
    } catch {
      // pre-M-6 install: no marker was ever written
    }
    if (verifiedTag && verifiedTag !== tag) {
      log(
        `cloudflared on disk was verified against ${verifiedTag}; pin is now ` +
          `${tag}. Delete ${target} to fetch and verify the pinned build.`,
      );
    } else if (!verifiedTag) {
      log(
        `cloudflared on disk predates checksum verification. Delete ${target} ` +
          'to re-fetch it against the pinned release.',
      );
    }
    return target;
  }

  const { asset, archive } = assetFor();
  const expected = assets[asset];
  if (!expected) {
    throw new Error(
      `no vendored SHA-256 for ${asset} at cloudflared ${tag}, so it cannot ` +
        `be verified and will not be run. ${BYO_BINARY_HINT}`,
    );
  }

  const url = `${releaseBase()}/${asset}`;
  log(`downloading cloudflared ${tag} (${asset})`);
  await fs.promises.mkdir(binDir, { recursive: true });

  if (archive === 'raw') {
    await download(url, target, expected);
  } else {
    const tgz = path.join(binDir, asset);
    await download(url, tgz, expected);
    await run('tar', ['-xzf', tgz, '-C', binDir]);
    await fs.promises.rm(tgz, { force: true });
    // The darwin tarball unpacks to `cloudflared` already; if a release
    // ever nests it, surface that clearly rather than failing at spawn.
    if (!fs.existsSync(target)) {
      throw new Error(`cloudflared not found in ${asset} after extraction`);
    }
  }

  await fs.promises.chmod(target, 0o755);
  fs.writeFileSync(
    markerPath(binDir),
    JSON.stringify({ tag, asset, sha256: expected }, null, 2),
  );
  log(`cloudflared ${tag} verified and ready`);
  return target;
}

/**
 * A supervised quick tunnel.
 *
 * Restarts with backoff if cloudflared exits -- which it does on network
 * loss and on sleep/wake -- and reports every hostname change through
 * `onUrl`.
 */
export class Tunnel {
  private child: ChildProcess | null = null;
  private stopped = false;
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;
  private monitor: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private failures = 0;
  private recycling = false;
  url: string | null = null;

  constructor(private readonly opts: TunnelOptions) {}

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private handleChunk(chunk: string): void {
    const found = parseTunnelUrl(chunk);
    if (!found || found === this.url) return;
    this.url = found;
    this.log(`tunnel url ${found}`);
    this.opts.onUrl?.(found);
  }

  /**
   * Probe the tunnel from the OUTSIDE.
   *
   * Checking that the child process is alive is not the same as checking
   * that the tunnel works, and after a sleep/wake cycle those two answers
   * routinely disagree: cloudflared keeps running while its edge
   * connections are dead, so `exit` never fires, nothing restarts, and the
   * hostname Telegram is pointed at serves Cloudflare's own 5xx error page
   * forever. Only a request that travels out to Cloudflare and back to this
   * process can tell the difference.
   */
  private async probe(url: string): Promise<boolean> {
    const fetchFn = this.opts.fetchFn || fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchFn(`${url}/api/health`, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'cache-control': 'no-cache' },
      });
      // Cloudflare's tunnel-down pages are 502/503/530. Anything this
      // origin generated itself (including a 401) proves the path is up.
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Tear the child down so the exit handler brings up a fresh hostname. */
  recycle(reason: string): void {
    if (this.stopped || this.recycling) return;
    this.recycling = true;
    this.failures = 0;
    this.url = null;
    this.log(`recycling tunnel: ${reason}`);
    const child = this.child;
    if (!child) {
      // Nothing running and no pending restart means the backoff timer was
      // the only thing holding it; let it proceed.
      this.recycling = false;
      return;
    }
    child.kill('SIGTERM');
    // A cloudflared wedged on a dead socket can ignore SIGTERM. Do not let
    // a hung child block the restart path indefinitely.
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000);
    hard.unref?.();
    child.once('exit', () => {
      clearTimeout(hard);
      this.recycling = false;
    });
  }

  private async tick(period: number): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const drift = now - this.lastTick;
    this.lastTick = now;

    if (drift > period + WAKE_DRIFT_MS) {
      // The lid was shut. Do not trust the old hostname, and do not wait
      // for a probe to time out first: recycle straight away so the menu
      // button is repointed while the user is still walking back to it.
      this.log(`wake detected after ~${Math.round(drift / 1000)}s asleep`);
      this.recycle('machine woke from sleep');
      return;
    }

    const url = this.url;
    if (!url) return;

    if (await this.probe(url)) {
      this.failures = 0;
      // A tunnel that has proven itself should not inherit the long backoff
      // earned by an earlier bad patch of network.
      this.restarts = 0;
      this.opts.onHealthy?.(url);
      return;
    }

    this.failures += 1;
    const limit = this.opts.healthFailureLimit ?? 2;
    this.log(`tunnel probe failed (${this.failures}/${limit})`);
    if (this.failures >= limit) this.recycle('public url stopped responding');
  }

  private startMonitor(): void {
    const period = this.opts.healthIntervalMs ?? 45_000;
    if (this.monitor || period <= 0) return;
    this.lastTick = Date.now();
    this.monitor = setInterval(() => {
      void this.tick(period).catch(() => {});
    }, period);
    this.monitor.unref?.();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.startMonitor();
    const supplied = userSuppliedCloudflared(this.opts.cloudflaredPath);
    if (supplied) {
      // Their binary, their call: nothing to verify and nothing to fetch.
      this.log(`using cloudflared at ${supplied}`);
      this.spawnOnce(supplied);
      return;
    }
    const bin = this.opts.downloadFn
      ? path.join(this.opts.binDir, 'cloudflared')
      : await ensureCloudflared(this.opts.binDir, (m) => this.log(m));
    if (this.opts.downloadFn) await this.opts.downloadFn(bin);
    this.spawnOnce(bin);
  }

  private spawnOnce(bin: string): void {
    if (this.stopped) return;
    const spawnFn = this.opts.spawnFn || spawn;
    this.log(`starting tunnel -> http://127.0.0.1:${this.opts.port}`);

    const child = spawnFn(
      bin,
      [
        'tunnel',
        '--no-autoupdate',
        // QUIC (UDP 7844) is blocked on some networks (e.g. VPNs), which
        // leaves the quick tunnel stuck serving Cloudflare 530 while the
        // process stays alive. HTTP/2 over TCP is the precheck-recommended
        // fallback and works through those same networks.
        '--protocol',
        'http2',
        '--url',
        `http://127.0.0.1:${this.opts.port}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;

    // cloudflared banners the URL on stderr, but read both: which stream
    // carries it has moved between releases.
    const onData = (buf: Buffer) => this.handleChunk(buf.toString('utf8'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      // A rotated hostname must not be reported as still live.
      this.url = null;
      this.restarts += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5));
      this.log(`tunnel exited (${code}); restarting in ${delay}ms`);
      this.timer = setTimeout(() => this.spawnOnce(bin), delay);
      this.timer.unref?.();
    });

    child.on('error', (err) => this.log(`tunnel error: ${err.message}`));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

/**
 * Read back what Telegram currently believes the menu button is.
 *
 * The write side already existed; without this read side there was no way
 * to notice that a write had been lost, and a lost write is precisely the
 * failure this file now exists to survive.
 */
export async function readMenuButton(
  botToken: string,
  chatId: number | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const query =
    chatId === undefined ? '' : `?chat_id=${encodeURIComponent(String(chatId))}`;
  const res = await fetchFn(
    `https://api.telegram.org/bot${botToken}/getChatMenuButton${query}`,
  );
  const body = (await res.json()) as {
    ok?: boolean;
    result?: { web_app?: { url?: string } };
  };
  if (!body?.ok) return null;
  return body.result?.web_app?.url || null;
}

/** Compare two menu-button urls ignoring a trailing slash. */
export function sameMenuUrl(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) => (v || '').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b) && norm(a) !== '';
}

export interface MenuSyncOptions {
  botToken: string;
  chatId: number | undefined;
  log?: (message: string) => void;
  fetchFn?: typeof fetch;
  /** How often to re-read Telegram and repair drift. 0 disables. */
  reconcileIntervalMs?: number;
  /** Attempts per target before giving up until the next reconcile. */
  maxAttempts?: number;
}

/**
 * Keeps Telegram's menu button pointed at the live tunnel.
 *
 * The original code called `setChatMenuButton` once per hostname rotation
 * and dropped the result on the floor. That is fine on a desktop with a
 * permanent link and fatal on a laptop: the rotation that matters most
 * happens the instant the machine wakes, which is the one moment the
 * network is least likely to be ready. When that single call failed --
 * logged verbatim as `menu button failed: fetch failed` on 2026-08-02 --
 * Telegram kept serving the previous, already-dead hostname with nothing
 * scheduled to ever correct it. The mini app was then broken until the
 * next unrelated restart.
 *
 * So: retry with backoff, and independently re-read the live value on a
 * timer so a silently lost write repairs itself rather than persisting.
 */
export class MenuSync {
  private target: string | null = null;
  private confirmed: string | null = null;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: MenuSyncOptions) {}

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** Point the button at `url`, retrying until Telegram confirms it. */
  setTarget(url: string): void {
    if (this.stopped) return;
    if (this.target === url) {
      // Already landed. Re-writing on every health probe would mean a
      // Bot API write every 45s for the life of the process, to say
      // something Telegram already knows.
      if (this.confirmed === url) return;
      void this.push();
      return;
    }
    this.target = url;
    this.attempt = 0;
    this.confirmed = null;
    void this.push();
  }

  private schedule(): void {
    if (this.stopped || this.retry) return;
    const max = this.opts.maxAttempts ?? 8;
    if (this.attempt >= max) {
      this.log(
        `menu button still unset after ${max} attempts; leaving it to the ` +
          'reconcile loop',
      );
      return;
    }
    // 2s, 4s, 8s ... capped. A laptop's network is usually back well
    // inside the first few of these, so the first retry is deliberately
    // the short one: `attempt` has already been incremented by the call
    // that just failed, so it is stepped back to keep 2s first.
    const step = Math.max(0, Math.min(this.attempt - 1, 5));
    const delay = Math.min(60_000, 2000 * 2 ** step);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.push();
    }, delay);
    this.retry.unref?.();
  }

  private async push(): Promise<void> {
    const url = this.target;
    if (this.stopped || !url) return;
    this.attempt += 1;
    try {
      const res = await registerMenuButton(
        this.opts.botToken,
        url,
        this.opts.chatId,
        this.opts.fetchFn || fetch,
      );
      if (!res.ok) {
        this.log(`menu button rejected: ${res.description || 'unknown'}`);
        this.schedule();
        return;
      }
      this.confirmed = url;
      this.attempt = 0;
      this.log('menu button registered');
    } catch (err) {
      this.log(
        `menu button attempt ${this.attempt} failed: ${(err as Error).message}`,
      );
      this.schedule();
    }
  }

  /**
   * Re-read Telegram and repair any drift.
   *
   * This is the backstop that makes the whole thing self-healing: even if
   * every retry above was exhausted while the network was down, the next
   * successful read notices the mismatch and writes again.
   */
  async reconcile(): Promise<void> {
    const url = this.target;
    if (this.stopped || !url) return;
    try {
      const live = await readMenuButton(
        this.opts.botToken,
        this.opts.chatId,
        this.opts.fetchFn || fetch,
      );
      if (sameMenuUrl(live, url)) {
        this.confirmed = url;
        return;
      }
      this.log(`menu button drifted (telegram has ${live || 'none'}); repairing`);
      this.attempt = 0;
      await this.push();
    } catch {
      // Offline. The next tick tries again; nothing to do here.
    }
  }

  start(): void {
    const period = this.opts.reconcileIntervalMs ?? 120_000;
    if (this.timer || period <= 0) return;
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => {});
    }, period);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
  }

  /** The url Telegram has confirmed, or null if the write never landed. */
  get liveUrl(): string | null {
    return this.confirmed;
  }
}

/**
 * The Telegram menu button payload.
 *
 * Built as a pure function so it can be asserted in tests without any
 * chance of a request going out.
 */
export function menuButtonPayload(
  url: string,
  text = 'Aside',
  chatId?: number,
) {
  // chat_id is set explicitly because per-chat menu buttons override the
  // bot default. A prior chat-level override (from manual setup or an older
  // build) silently overrides later chat-less setChatMenuButton calls: the
  // API returns ok:true while the owner's chat keeps serving the stale URL.
  // Targeting the owner chat directly updates both the per-chat button and,
  // when none is set, falls through to the default.
  const payload: Record<string, unknown> = {
    menu_button: {
      type: 'web_app',
      text,
      web_app: { url },
    },
  };
  if (chatId !== undefined) payload.chat_id = chatId;
  return payload;
}

/**
 * Point the bot's menu button at `url`.
 *
 * This is the ONLY Bot API call in this codebase. It is gated on
 * `miniapp.auto_register_menu`, which is off by default: the bot is live
 * in production and re-registering its menu is the owner's decision, not
 * something an install should do on its own.
 */
export async function registerMenuButton(
  botToken: string,
  url: string,
  chatId: number | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; description?: string }> {
  const res = await fetchFn(
    `https://api.telegram.org/bot${botToken}/setChatMenuButton`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(menuButtonPayload(url, 'Aside', chatId)),
    },
  );
  const body = (await res.json()) as { ok?: boolean; description?: string };
  return { ok: Boolean(body?.ok), description: body?.description };
}

/** Trim a log file that has grown past `maxBytes`, keeping the tail. */
export function rotateLog(logPath: string, maxBytes: number): void {
  try {
    const stat = fs.statSync(logPath, { throwIfNoEntry: false });
    if (!stat || stat.size <= maxBytes) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Logging must never take the server down.
  }
}

export function defaultBinDir(stateDir: string): string {
  return path.join(
    stateDir || path.join(defaultAsideRoot(), 'telegram-bridge'),
    'bin',
  );
}
