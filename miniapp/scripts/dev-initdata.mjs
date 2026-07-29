#!/usr/bin/env node
/**
 * Dev harness: print a browser URL carrying a genuinely signed initData
 * payload, so a normal desktop browser can exercise the real auth path
 * without Telegram.
 *
 *   node miniapp/scripts/dev-initdata.mjs [--platform ios|desktop] [--port 8790]
 *
 * Reads the bot token and allowlisted user id from the bridge config
 * (MINIAPP_CONFIG overrides the path). The token is used only as HMAC key
 * material -- it is never printed and never appears in the URL. The
 * printed URL contains a signed payload plus your Telegram user id, and it
 * expires after 15 minutes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInitDataFields, signInitData } from './sign-initdata.mjs';

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

// Same search order the server uses: setup.py writes config.json into the
// checkout, and the ~/.aside path is the older home.
const configCandidates = process.env.MINIAPP_CONFIG
  ? [expandHome(process.env.MINIAPP_CONFIG)]
  : [
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../..',
        'config.json',
      ),
      expandHome('~/.aside/u/0/telegram-bridge/config.json'),
    ];
const configPath =
  configCandidates.find((candidate) => fs.existsSync(candidate)) ??
  configCandidates[0];

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`cannot read config at ${configPath}: ${err.message}`);
  if (configCandidates.length > 1) {
    console.error(`looked in: ${configCandidates.join(', ')}`);
  }
  process.exit(1);
}

if (!config.token || !config.chat_id) {
  console.error(`config ${configPath} needs both "token" and "chat_id"`);
  process.exit(1);
}

const platform = arg('platform', 'desktop');
const port = arg('port', process.env.MINIAPP_PORT || '8790');
const host = arg('host', '127.0.0.1');

const fields = buildInitDataFields({
  userId: Number(config.chat_id),
  firstName: String(config.owner_name || 'Owner'),
  platform,
});
const initDataRaw = signInitData(fields, String(config.token));

const url = `http://${host}:${port}/#initData=${encodeURIComponent(initDataRaw)}`;

console.log(`platform : ${platform}`);
console.log(`valid for: 15 minutes`);
console.log('');
console.log(url);
