#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { loadConfig, loadOrCreateJwtSecret } from './config.js';
import { defaultPairingPath, PairingStore } from './pairing.js';
import { parseTailscaleUrl } from './tailscale.js';

const config = loadConfig();
const secret = loadOrCreateJwtSecret(config.secretPath);
const code = new PairingStore(
  defaultPairingPath(config.miniapp.stateDir),
  secret,
).create();

function publicOrigin(): string {
  if (config.miniapp.publicUrl) {
    return config.miniapp.publicUrl;
  }

  if (config.miniapp.tunnel === 'tailscale') {
    try {
      const command = process.env.MINIAPP_TAILSCALE_PATH || config.miniapp.tailscalePath || 'tailscale';
      const output = execFileSync(command, ['funnel', 'status', '--json'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const origin = parseTailscaleUrl(output);
      if (origin) {
        return origin;
      }
    } catch {
      // Fall back to the local origin when Funnel is not available yet.
    }
  }

  return `http://127.0.0.1:${config.port}`;
}

const origin = publicOrigin();

console.log(`Open ${origin} on the device you want to pair.`);
console.log(`Pairing code: ${code}`);
console.log('This code expires in 10 minutes and can only be used once.');
