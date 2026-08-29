import { EventEmitter } from 'node:events';
import { discoverSerialCandidates, type SerialCandidate } from './discovery.js';
import { Modem } from './modem.js';
import type { IncomingSms } from './sms-rx.js';
import type { Repo } from '../store/repo.js';
import type { Logger } from '../logger.js';

export interface RegistryOptions {
  repo: Repo;
  logger: Logger;
  labels: Record<string, string>;
  scanIntervalMs: number;
  concatTimeoutMs: number;
}

/** Backoff before retrying a port that failed to open, so we don't spin on it. */
const RETRY_COOLDOWN_MS = 60_000;

/**
 * Tracks every attached SIM7070 and keeps the set current as modules come and go.
 *
 * Modems are keyed by USB topology (`usbLocation`) rather than device node,
 * because `ttyUSBn` is reassigned on replug and every SIM7070G shares one
 * hardcoded USB serial number.
 */
export class ModemRegistry extends EventEmitter {
  private readonly repo: Repo;
  private readonly log: Logger;
  private readonly labels: Record<string, string>;
  private readonly scanIntervalMs: number;
  private readonly concatTimeoutMs: number;

  private readonly modems = new Map<string, Modem>();
  private readonly cooldowns = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private stopped = false;

  constructor(opts: RegistryOptions) {
    super();
    this.repo = opts.repo;
    this.log = opts.logger.child({ component: 'registry' });
    this.labels = opts.labels;
    this.scanIntervalMs = opts.scanIntervalMs;
    this.concatTimeoutMs = opts.concatTimeoutMs;
  }

  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.scanIntervalMs);
    // Don't hold the event loop open on this interval alone.
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.modems.values()].map((m) => m.close().catch(() => undefined)));
    this.modems.clear();
  }

  list(): Modem[] {
    return [...this.modems.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  byId(id: number): Modem | null {
    return this.list().find((m) => m.id === id) ?? null;
  }

  get size(): number {
    return this.modems.size;
  }

  private async tick(): Promise<void> {
    await this.scan();
    for (const modem of this.list()) {
      try {
        await modem.poll();
      } catch (err) {
        this.log.warn(
          { modem: modem.label, err: (err as Error).message },
          'poll failed',
        );
      }
    }
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      const candidates = await discoverSerialCandidates(this.log);
      const present = new Set(candidates.map((c) => c.usbLocation));

      // Drop modems whose USB slot no longer reports a SIMCom AT port.
      for (const [location, modem] of this.modems) {
        if (!present.has(location) || !modem.isOpen) {
          this.log.info({ modem: modem.label, location }, 'modem detached');
          await modem.close().catch(() => undefined);
          this.modems.delete(location);
          this.emit('detached', modem);
        }
      }

      for (const candidate of candidates) {
        if (this.modems.has(candidate.usbLocation)) continue;
        const cooldown = this.cooldowns.get(candidate.usbLocation);
        if (cooldown && Date.now() < cooldown) continue;
        await this.attach(candidate);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async attach(candidate: SerialCandidate): Promise<void> {
    const modem = new Modem({
      candidate,
      repo: this.repo,
      logger: this.log,
      labels: this.labels,
      concatTimeoutMs: this.concatTimeoutMs,
    });

    try {
      await modem.open();
    } catch (err) {
      const message = (err as Error).message;
      this.cooldowns.set(candidate.usbLocation, Date.now() + RETRY_COOLDOWN_MS);
      await modem.close().catch(() => undefined);

      if (/permission denied|EACCES/i.test(message)) {
        this.log.error(
          { path: candidate.path },
          'permission denied opening port — install deploy/99-sim7070.rules (see README)',
        );
      } else {
        this.log.warn({ path: candidate.path, err: message }, 'failed to attach modem');
      }
      return;
    }

    this.cooldowns.delete(candidate.usbLocation);
    this.modems.set(candidate.usbLocation, modem);
    modem.on('sms', (sms: IncomingSms) => this.emit('sms', sms, modem));
    modem.on('lost', () => {
      this.modems.delete(candidate.usbLocation);
      this.emit('detached', modem);
    });
    this.emit('attached', modem);
  }
}
