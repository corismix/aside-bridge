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
  throw new Error(`cloudflared is not supported on ${platform}/${arch}`);
}

/**
 * First trycloudflare URL in a chunk of cloudflared output.
 *
 * cloudflared banners the URL inside an ASCII box across several lines, so
 * this scans rather than matching a fixed line shape.
 */
export function parseTunnelUrl(chunk: string): string | null {
  const matches = String(chunk || '').match(URL_RE);
  return matches && matches.length ? matches[0].toLowerCase() : null;
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
}

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

  async start(): Promise<void> {
    this.stopped = false;
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
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

/**
 * The Telegram menu button payload.
 *
 * Built as a pure function so it can be asserted in tests without any
 * chance of a request going out.
 */
export function menuButtonPayload(url: string, text = 'Aside') {
  return {
    menu_button: {
      type: 'web_app',
      text,
      web_app: { url },
    },
  };
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
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; description?: string }> {
  const res = await fetchFn(
    `https://api.telegram.org/bot${botToken}/setChatMenuButton`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(menuButtonPayload(url)),
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
  return path.join(stateDir || path.join(os.homedir(), '.aside/u/0/telegram-bridge'), 'bin');
}
