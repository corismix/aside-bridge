/**
 * Entry point. Reads the bridge config, mints/loads the JWT secret, and
 * serves the API plus the built SPA on MINIAPP_PORT (default 8790).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './app.js';
import { loadConfig, loadOrCreateJwtSecret } from './config.js';
import { MenuSync, Tunnel, defaultBinDir } from './tunnel.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const jwtSecret = loadOrCreateJwtSecret(config.secretPath);
  const webDist =
    process.env.MINIAPP_WEB_DIST || path.resolve(here, '../../web/dist');

  // Declared up here so the status route can read the tunnel's CURRENT
  // hostname: a quick tunnel rotates it while we run, so anything captured
  // at boot goes stale.
  let tunnel: Tunnel | null = null;

  const { app } = await buildServer(config, {
    webDist,
    jwtSecret,
    logger: process.env.MINIAPP_LOG !== '0',
    publicUrl: () => tunnel?.url ?? null,
    version: process.env.MINIAPP_VERSION || '0.1.0',
  });

  const host = process.env.MINIAPP_HOST || '127.0.0.1';
  await app.listen({ port: config.port, host });

  // Deliberately terse: no token, no secret, no user id in the logs.
  app.log.info(
    { sessionsDir: config.sessionsDir, webDist },
    `aside mini app listening on http://${host}:${config.port}`,
  );

  let menu: MenuSync | null = null;

  if (config.miniapp.tunnel === 'cloudflared') {
    if (config.miniapp.autoRegisterMenu) {
      // Owns retries and drift repair. A single fire-and-forget call used
      // to live inline here, and losing that one call (network not up yet
      // on wake) left Telegram pointed at a dead hostname permanently.
      menu = new MenuSync({
        botToken: config.botToken,
        chatId: config.allowedUserId,
        log: (message) => app.log.info(message),
      });
      menu.start();
    } else {
      app.log.info(
        'menu auto-registration is off; set miniapp.auto_register_menu to enable',
      );
    }

    tunnel = new Tunnel({
      port: config.port,
      binDir: defaultBinDir(config.miniapp.stateDir),
      cloudflaredPath: config.miniapp.cloudflaredPath || undefined,
      log: (message) => app.log.info(message),
      onUrl: (url) => {
        app.log.info(`public url: ${url}`);
        // Re-runs on every hostname rotation, which is what keeps an
        // ephemeral quick-tunnel usable as a menu button target.
        menu?.setTarget(url);
      },
      onHealthy: (url) => {
        // The tunnel is provably reachable from the public internet, so
        // this is the right moment to confirm Telegram agrees about where
        // to send people. `reconcile` reads first and only writes on a
        // genuine mismatch, which closes the last gap -- a write that
        // returned ok but did not stick -- without turning the health
        // probe into a write loop.
        menu?.setTarget(url);
        void menu?.reconcile();
      },
    });
    tunnel.start().catch((err) => {
      app.log.error(`tunnel failed to start: ${err.message}`);
    });
  }

  /*
   * Node terminates the process on an unhandled rejection. This server is
   * meant to sit running for weeks behind a KeepAlive job, and it is full
   * of deliberate fire-and-forget `void` calls -- menu registration, read
   * marking, subagent refreshes. Any one of those growing a throw would
   * take the whole app down and take the tunnel with it. Log it and stay
   * up; a dropped background task is recoverable, a dead process is not.
   */
  process.on('unhandledRejection', (reason) => {
    app.log.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandled rejection',
    );
  });

  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaught exception');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      tunnel?.stop();
      menu?.stop();
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

main().catch((err) => {
  console.error(`miniapp failed to start: ${(err as Error).message}`);
  process.exit(1);
});
