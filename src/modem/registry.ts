import { EventEmitter } from 'node:events';
import { explainEmptyScan, scanForModems, type SerialCandidate } from './discovery.js';
import { Modem } from './modem.js';
import { diagnoseOpenError } from './open-errors.js';
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
  private lastEmptyReason: string | null = null;
  /** When a module vanished from a slot, so recovery can be reported. */
  private readonly lostAt = new Map<string, number>();
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
      const report = await scanForModems(this.log);
      const candidates = report.candidates;

      if (candidates.length === 0 && this.modems.size === 0) {
        const reason = explainEmptyScan(report);
        // Only once per distinct reason: this runs on every scan interval.
        if (reason !== this.lastEmptyReason) {
          this.lastEmptyReason = reason;
          this.log.warn(`no modems found — ${reason}`);
        }
      } else {
        this.lastEmptyReason = null;
      }

      const present = new Set(candidates.map((c) => c.usbLocation));

      // Drop modems whose USB slot no longer reports a SIMCom AT port.
      for (const [location, modem] of this.modems) {
        const vanished = !present.has(location);
        if (!vanished && modem.isOpen) continue;

        if (vanished) {
          // The module left the USB bus entirely, which is a different problem
          // from a closed port: either the firmware reset itself, or the supply
          // sagged. A SIM7070 draws ~2A peaks while transmitting, and an attach
          // attempt is exactly when it transmits hardest.
          this.log.warn(
            { modem: modem.label, location },
            'module disappeared from USB — it reset or browned out; if this repeats ' +
              'during network operations, suspect the power supply before the firmware',
          );
          this.lostAt.set(location, Date.now());
        } else {
          this.log.info({ modem: modem.label, location }, 'modem port closed');
        }

        await modem.close().catch(() => undefined);
        this.modems.delete(location);
        this.emit('detached', modem);
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

      const hint = diagnoseOpenError(message);
      if (hint) {
        this.log.error({ path: candidate.path }, `cannot open port: ${hint}`);
      } else {
        this.log.warn({ path: candidate.path, err: message }, 'failed to attach modem');
      }
      return;
    }

    this.cooldowns.delete(candidate.usbLocation);
    const lostAt = this.lostAt.get(candidate.usbLocation);
    if (lostAt !== undefined) {
      this.lostAt.delete(candidate.usbLocation);
      this.log.info(
        { modem: modem.label, downMs: Date.now() - lostAt, path: candidate.path },
        'module came back after disappearing — re-attached',
      );
    }
    this.modems.set(candidate.usbLocation, modem);
    modem.on('sms', (sms: IncomingSms) => this.emit('sms', sms, modem));
    modem.on('lost', () => {
      this.modems.delete(candidate.usbLocation);
      this.lostAt.set(candidate.usbLocation, Date.now());
      // Release the serial handle. Without this the descriptor leaks on every
      // re-enumeration, and the stale handle can make the re-attach fail with
      // EBUSY -- a self-inflicted version of the ModemManager problem.
      void modem.close().catch(() => undefined);
      this.emit('detached', modem);
    });
    this.emit('attached', modem);
  }
}
