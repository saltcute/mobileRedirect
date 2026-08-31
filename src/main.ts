import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { openDatabase } from './store/db.js';
import { Repo } from './store/repo.js';
import { ModemRegistry, type DetachReason } from './modem/registry.js';
import { createBot, publishCommandMenu } from './telegram/bot.js';
import * as alerts from './telegram/alerts.js';
import type { Modem } from './modem/modem.js';
import type { IncomingSms } from './modem/sms-rx.js';
import type { SerialCandidate } from './modem/discovery.js';
import type { Transition } from './modem/health-state.js';
import type { Notification } from './telegram/notify.js';

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
  const notify = gateway.notifier;

  /**
   * Boot fires one `attached` per module and, when nothing is found, one
   * `scan-empty`. Those are collected rather than sent, so startup is a single
   * message listing what came up instead of a burst of near-identical ones.
   */
  let booted = false;
  let bootEmptyReason: string | null = null;
  const bootFailures: Notification[] = [];

  // Registered before `registry.start()`, which runs the first scan inside it.
  registry.on('sms', (sms: IncomingSms, modem: Modem) => {
    logger.info({ modem: modem.label, from: sms.from, parts: sms.parts }, 'sms received');
    void gateway.publishSms(sms, modem);
  });

  registry.on('attached', (modem: Modem, downMs: number | null) => {
    logger.info({ modem: modem.label, path: modem.devicePath, downMs }, 'modem attached');
    if (booted) void notify.send(alerts.attached(modem.label, modem.devicePath, downMs));
  });

  registry.on('detached', (modem: Modem, reason: DetachReason) => {
    if (booted) void notify.send(alerts.detached(modem.label, reason));
  });

  registry.on('attach-failed', (candidate: SerialCandidate, message: string, hint: string | null) => {
    const alert = alerts.attachFailed(candidate.path, candidate.usbLocation, message, hint);
    // Held back at boot so it lands after the startup message rather than
    // racing it — a permission-denied port is the first thing you want to read,
    // but only once you know which process it came from.
    if (booted) void notify.send(alert);
    else bootFailures.push(alert);
  });

  registry.on('scan-empty', (reason: string) => {
    if (booted) void notify.send(alerts.scanEmpty(reason));
    else bootEmptyReason = reason;
  });

  registry.on('poll-failing', (modem: Modem, consecutive: number, message: string) => {
    void notify.send(alerts.pollFailing(modem.label, consecutive, message));
  });

  registry.on('poll-recovered', (modem: Modem) => {
    void notify.send(alerts.pollRecovered(modem.label));
  });

  registry.on('hardware', (modem: Modem, urc: string) => {
    void notify.send(alerts.hardwareCondition(modem.label, urc));
  });

  registry.on('sim-changed', (modem: Modem, t: Extract<Transition, { type: 'sim-changed' }>) => {
    logger.info({ modem: modem.label, from: t.from?.detail, to: t.to.detail }, 'sim state changed');
    void notify.send(alerts.simChanged(modem.label, t.from, t.to));
  });

  registry.on('signal-low', (modem: Modem, t: Extract<Transition, { type: 'signal-low' }>) => {
    void notify.send(alerts.signalLow(modem.label, t.bars));
  });

  registry.on('signal-recovered', (modem: Modem, t: Extract<Transition, { type: 'signal-recovered' }>) => {
    void notify.send(alerts.signalRecovered(modem.label, t.bars));
  });

  await registry.start();
  if (registry.size === 0) {
    // The registry has already logged the specific reason; don't guess at a
    // different one here.
    logger.warn('starting with no modems attached — scanning continues in the background');
  }

  // Awaited so the boot sequence arrives in order; every later send is
  // fire-and-forget.
  const inventory = registry.list().map((m) => ({ label: m.label, devicePath: m.devicePath }));
  await notify.send(alerts.started(inventory, bootEmptyReason));
  for (const failure of bootFailures) await notify.send(failure);
  booted = true;

  await publishCommandMenu(gateway.bot).catch((err: Error) =>
    logger.warn({ err: err.message }, 'could not publish command menu'),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // Awaited, unlike every other notification: process.exit() follows straight
    // after and would cut a fire-and-forget send off mid-flight.
    await notify.send(alerts.stopped(signal));
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
