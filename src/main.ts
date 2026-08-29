import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { openDatabase } from './store/db.js';
import { Repo } from './store/repo.js';
import { ModemRegistry } from './modem/registry.js';
import { createBot, publishCommandMenu } from './telegram/bot.js';
import type { Modem } from './modem/modem.js';
import type { IncomingSms } from './modem/sms-rx.js';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;

  const db = openDatabase(config.DB_PATH);
  const repo = new Repo(db);

  const registry = new ModemRegistry({
    repo,
    logger,
    labels: config.MODEM_LABELS,
    scanIntervalMs: config.SCAN_INTERVAL_MS,
    concatTimeoutMs: config.CONCAT_TIMEOUT_MS,
  });

  const gateway = createBot({ registry, repo, config, logger });

  registry.on('sms', (sms: IncomingSms, modem: Modem) => {
    logger.info({ modem: modem.label, from: sms.from, parts: sms.parts }, 'sms received');
    void gateway.publishSms(sms, modem);
  });
  registry.on('attached', (modem: Modem) => {
    logger.info({ modem: modem.label, path: modem.devicePath }, 'modem attached');
  });

  await registry.start();
  if (registry.size === 0) {
    // The registry has already logged the specific reason; don't guess at a
    // different one here.
    logger.warn('starting with no modems attached — scanning continues in the background');
  }

  await publishCommandMenu(gateway.bot).catch((err: Error) =>
    logger.warn({ err: err.message }, 'could not publish command menu'),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await gateway.bot.stop().catch(() => undefined);
    await registry.stop().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info(
    { modems: registry.size, notifyChats: gateway.notifyChatIds.length },
    'starting telegram bot',
  );
  // Long polling: the Pi sits behind NAT, so there is no inbound webhook path.
  await gateway.bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'telegram bot online'),
  });
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, 'fatal startup error');
  process.exitCode = 1;
});
