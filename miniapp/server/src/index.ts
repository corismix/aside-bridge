/**
 * Entry point. Reads the bridge config, mints/loads the JWT secret, and
 * serves the API plus the built SPA on MINIAPP_PORT (default 8790).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './app.js';
import { loadConfig, loadOrCreateJwtSecret } from './config.js';
import { Tunnel, defaultBinDir, registerMenuButton } from './tunnel.js';

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

  if (config.miniapp.tunnel === 'cloudflared') {
    tunnel = new Tunnel({
      port: config.port,
      binDir: defaultBinDir(config.miniapp.stateDir),
      cloudflaredPath: config.miniapp.cloudflaredPath || undefined,
      log: (message) => app.log.info(message),
      onUrl: (url) => {
        app.log.info(`public url: ${url}`);
        if (!config.miniapp.autoRegisterMenu) {
          app.log.info(
            'menu auto-registration is off; set miniapp.auto_register_menu to enable',
          );
          return;
        }
        // Re-runs on every hostname rotation, which is what keeps an
        // ephemeral quick-tunnel usable as a menu button target.
        registerMenuButton(config.botToken, url).then(
          (res) =>
            app.log.info(
              res.ok
                ? 'menu button registered'
                : `menu button rejected: ${res.description}`,
            ),
          (err) => app.log.error(`menu button failed: ${err.message}`),
        );
      },
    });
    tunnel.start().catch((err) => {
      app.log.error(`tunnel failed to start: ${err.message}`);
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      tunnel?.stop();
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
