/** Tailscale Funnel supervision for the standalone PWA. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST_RE = /(?:https:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)\.?/i;

export function parseTailscaleUrl(output: string): string | null {
  const host = String(output || '').match(HOST_RE)?.[1];
  return host ? `https://${host}`.toLowerCase() : null;
}

export interface TailscaleTunnelOptions {
  port: number;
  tailscalePath?: string;
  onUrl?: (url: string) => void;
  log?: (message: string) => void;
  /** Injected in tests so no Tailscale daemon or network is touched. */
  runFn?: (args: string[]) => Promise<string>;
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
  return String(result.stdout || '') + String(result.stderr || '');
}

/**
 * Configure the already-installed Tailscale backend to expose the local
 * server. Funnel owns its own background process and keeps the hostname
 * stable across Tailscale and Mac restarts; this process only ensures the
 * route exists and reports its URL to the app/menu synchronisation.
 */
export class TailscaleTunnel {
  url: string | null = null;
  private stopped = false;

  constructor(private readonly opts: TailscaleTunnelOptions) {}

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private run(args: string[]): Promise<string> {
    if (this.opts.runFn) return this.opts.runFn(args);
    const command = process.env.MINIAPP_TAILSCALE_PATH ||
      this.opts.tailscalePath || 'tailscale';
    return runCommand(command, args);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.log(`starting Tailscale Funnel -> http://127.0.0.1:${this.opts.port}`);
    await this.run([
      'funnel',
      '--bg',
      '--yes',
      `http://127.0.0.1:${this.opts.port}`,
    ]);
    if (this.stopped) return;

    const status = await this.run(['funnel', 'status', '--json']);
    const url = parseTailscaleUrl(status);
    if (!url) {
      throw new Error(
        'Tailscale Funnel did not report a public ts.net URL; ' +
          'ensure the Tailscale app is running, logged in, and Funnel is enabled',
      );
    }
    this.url = url;
    this.log(`public url: ${url}`);
    this.opts.onUrl?.(url);
  }

  stop(): void {
    // Deliberately leave Funnel configured. `--bg` makes it survive a
    // server restart, and the local origin is unavailable while this app is
    // stopped. Reset it explicitly with `tailscale funnel reset` if needed.
    this.stopped = true;
    this.url = null;
  }
}
