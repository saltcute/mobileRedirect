import { EventEmitter } from 'node:events';
import { explainEmptyScan, scanForModems, type SerialCandidate } from './discovery.js';
import { Modem } from './modem.js';
import { diagnoseOpenError } from './open-errors.js';
import { diffHealth, initialHealthState, type HealthState } from './health-state.js';
import type { IncomingSms } from './sms-rx.js';
import type { Repo } from '../store/repo.js';
import type { Logger } from '../logger.js';

/** Why a modem left the registry. */
export type DetachReason = 'vanished' | 'port-closed' | 'channel-lost';

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
 * Consecutive `poll()` failures before the modem is called unhealthy.
 *
 * One failure is routine — a poll can collide with a long `/network scan` or a
 * momentary hiccup. Three in a row is a module that is attached but not talking.
 */
const POLL_FAILURE_THRESHOLD = 3;

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
  /**
   * SIM and signal state per slot, for edge-triggering.
   *
   * Keyed by `usbLocation` rather than by `Modem`, so it survives a re-attach:
   * a module that re-enumerates must not re-announce the SIM that never moved.
   */
  private readonly health = new Map<string, HealthState>();
  private readonly healthInFlight = new Set<string>();
  private readonly pollFailures = new Map<string, number>();
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
        this.notePollSuccess(modem);
      } catch (err) {
        this.notePollFailure(modem, err as Error);
      }
      await this.pollHealth(modem);
    }
  }

  private notePollFailure(modem: Modem, err: Error): void {
    const consecutive = (this.pollFailures.get(modem.usbLocation) ?? 0) + 1;
    this.pollFailures.set(modem.usbLocation, consecutive);
    this.log.warn({ modem: modem.label, err: err.message, consecutive }, 'poll failed');
    // Emitted on every failure past the threshold, not just the one that crosses
    // it: the notifier throttles by key, so a module that stays broken produces
    // an occasional reminder instead of a single message hours ago.
    if (consecutive >= POLL_FAILURE_THRESHOLD) {
      this.emit('poll-failing', modem, consecutive, err.message);
    }
  }

  private notePollSuccess(modem: Modem): void {
    const consecutive = this.pollFailures.get(modem.usbLocation) ?? 0;
    this.pollFailures.delete(modem.usbLocation);
    if (consecutive >= POLL_FAILURE_THRESHOLD) this.emit('poll-recovered', modem, consecutive);
  }

  /** Sample SIM and signal state, and emit whatever changed. */
  private async pollHealth(modem: Modem): Promise<void> {
    const location = modem.usbLocation;
    // `tick()` has no reentrancy guard of its own, and one `/network scan` holds
    // this modem's command queue for up to three minutes. Without this flag every
    // interval that elapsed meanwhile would pile another health poll onto it.
    if (this.healthInFlight.has(location)) return;
    this.healthInFlight.add(location);
    try {
      const snapshot = await modem.health();
      const previous = this.health.get(location) ?? initialHealthState();
      const { state, transitions } = diffHealth(previous, snapshot);
      this.health.set(location, state);
      for (const transition of transitions) this.emit(transition.type, modem, transition);
    } catch (err) {
      this.log.debug(
        { modem: modem.label, err: (err as Error).message },
        'health poll failed',
      );
    } finally {
      this.healthInFlight.delete(location);
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
          this.emit('scan-empty', reason);
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
        this.emit('detached', modem, vanished ? 'vanished' : 'port-closed');
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
      this.emit('attach-failed', candidate, message, hint);
      return;
    }

    this.cooldowns.delete(candidate.usbLocation);
    // Down-time when this slot is coming back from a disappearance, else null.
    // Reported on `attached` rather than as its own event so a recovery is one
    // message instead of two.
    let downMs: number | null = null;
    const lostAt = this.lostAt.get(candidate.usbLocation);
    if (lostAt !== undefined) {
      downMs = Date.now() - lostAt;
      this.lostAt.delete(candidate.usbLocation);
      this.log.info(
        { modem: modem.label, downMs, path: candidate.path },
        'module came back after disappearing — re-attached',
      );
    }
    this.modems.set(candidate.usbLocation, modem);
    modem.on('sms', (sms: IncomingSms) => this.emit('sms', sms, modem));
    modem.on('hardware', (line: string) => this.emit('hardware', modem, line));
    modem.on('lost', (err: Error) => {
      this.modems.delete(candidate.usbLocation);
      this.lostAt.set(candidate.usbLocation, Date.now());
      // This path had no log line of its own: the only trace was the channel's
      // own 'channel failed' warning, which does not name the modem.
      this.log.warn(
        { modem: modem.label, location: candidate.usbLocation, err: err?.message },
        'modem channel lost — releasing the port until it re-enumerates',
      );
      // Release the serial handle. Without this the descriptor leaks on every
      // re-enumeration, and the stale handle can make the re-attach fail with
      // EBUSY -- a self-inflicted version of the ModemManager problem.
      void modem.close().catch(() => undefined);
      this.emit('detached', modem, 'channel-lost');
    });
    this.emit('attached', modem, downMs);
  }
}
