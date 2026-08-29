import { EventEmitter } from 'node:events';
import { AtChannel } from './at-channel.js';
import { SmsReceiver, type IncomingSms } from './sms-rx.js';
import { sendSms, type SendResult } from './sms-tx.js';
import type { SerialCandidate } from './discovery.js';
import type { Repo } from '../store/repo.js';
import type { Logger } from '../logger.js';
import {
  parseCeer,
  parseCmnb,
  parseCnmp,
  parseCnum,
  parseCops,
  parseCopsScan,
  parseCpin,
  parseCpms,
  parseCpsi,
  parseCreg,
  parseCsq,
  parseIccid,
  parseImei,
  normaliseNumber,
  type OperatorInfo,
  type RegistrationInfo,
  type ScannedOperator,
  type SignalInfo,
  type StorageInfo,
} from './parse.js';

export interface ModemIdentity {
  imei: string;
  iccid: string | null;
  ownNumber: string | null;
}

export interface ModemStatus {
  label: string;
  imei: string;
  iccid: string | null;
  ownNumber: string | null;
  devicePath: string;
  usbLocation: string;
  simState: string | null;
  signal: SignalInfo | null;
  operator: OperatorInfo | null;
  registration: RegistrationInfo | null;
  gprsRegistration: RegistrationInfo | null;
  systemInfo: string | null;
  storage: StorageInfo | null;
}

export interface ModemOptions {
  candidate: SerialCandidate;
  repo: Repo;
  logger: Logger;
  labels: Record<string, string>;
  concatTimeoutMs: number;
}

export class Modem extends EventEmitter {
  readonly candidate: SerialCandidate;
  private readonly repo: Repo;
  private readonly log: Logger;
  private readonly labels: Record<string, string>;
  private readonly concatTimeoutMs: number;

  private channel!: AtChannel;
  private receiver!: SmsReceiver;

  id!: number;
  identity!: ModemIdentity;
  label!: string;

  constructor(opts: ModemOptions) {
    super();
    this.candidate = opts.candidate;
    this.repo = opts.repo;
    this.labels = opts.labels;
    this.concatTimeoutMs = opts.concatTimeoutMs;
    this.log = opts.logger.child({ usb: opts.candidate.usbLocation });
  }

  get devicePath(): string {
    return this.candidate.path;
  }

  get usbLocation(): string {
    return this.candidate.usbLocation;
  }

  get isOpen(): boolean {
    return this.channel?.isOpen ?? false;
  }

  async open(): Promise<void> {
    this.channel = new AtChannel({ path: this.candidate.path, logger: this.log });
    await this.channel.open();

    this.channel.on('failed', (err: Error) => {
      this.log.warn({ err: err.message }, 'modem channel lost');
      this.emit('lost', err);
    });

    await this.handshake();
    await this.configure();

    this.identity = await this.readIdentity();
    this.label = this.resolveLabel(this.identity);
    this.id = this.repo.upsertModem({
      imei: this.identity.imei,
      iccid: this.identity.iccid,
      label: this.label,
      ownNumber: this.identity.ownNumber,
      usbLocation: this.candidate.usbLocation,
    });

    this.receiver = new SmsReceiver({
      channel: this.channel,
      repo: this.repo,
      modemId: this.id,
      logger: this.log.child({ modem: this.label }),
      concatTimeoutMs: this.concatTimeoutMs,
    });
    this.receiver.on('sms', (sms: IncomingSms) => this.emit('sms', sms, this));

    this.log.info(
      { label: this.label, imei: this.identity.imei, iccid: this.identity.iccid },
      'modem ready',
    );

    await this.receiver.drain();
  }

  /**
   * The module emits boot chatter (`RDY`, `SMS Ready`, `PB DONE`) for several
   * seconds after enumeration and ignores commands until it settles, so the
   * first `AT` gets several attempts.
   *
   * Sized for the worst case rather than a cold plug: after a firmware reset or
   * a brownout the module re-enumerates and needs 10-15s before it answers, and
   * giving up early there costs a full retry cooldown before the gateway tries
   * again.
   */
  private async handshake(attempts = 12): Promise<void> {
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.channel.execute('AT', 2000);
        return;
      } catch (err) {
        if (i === attempts) {
          throw new Error(
            `${this.candidate.path} did not answer AT after ${attempts} attempts: ${(err as Error).message}`,
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async configure(): Promise<void> {
    // Echo off first — everything downstream assumes responses aren't prefixed
    // with the command that produced them.
    await this.channel.execute('ATE0');
    // Numeric+verbose CME errors, so failures name a cause.
    await this.channel.execute('AT+CMEE=2');
    // PDU mode: required for UCS-2 and for multipart UDHs.
    await this.channel.execute('AT+CMGF=0');
    // Read/write/store SMS on the SIM.
    await this.channel.execute('AT+CPMS="SM","SM","SM"');
    // Route new-message *indications* (not payloads) to us: the message is
    // stored and we get +CMTI with its index. Delivering payloads inline
    // (+CMT) would lose messages whenever the link is momentarily down.
    await this.channel.execute('AT+CNMI=2,1,0,0,0');
  }

  private async readIdentity(): Promise<ModemIdentity> {
    const imeiLines = await this.channel.execute('AT+CGSN');
    const imei = parseImei(imeiLines);
    if (!imei) throw new Error(`could not read IMEI from ${this.candidate.path}`);

    let iccid: string | null = null;
    for (const cmd of ['AT+CICCID', 'AT+CCID']) {
      try {
        iccid = parseIccid(await this.channel.execute(cmd));
        if (iccid) break;
      } catch {
        // Firmware revisions differ on which spelling they accept.
      }
    }

    let ownNumber: string | null = null;
    try {
      const n = parseCnum(await this.channel.execute('AT+CNUM'));
      ownNumber = n ? normaliseNumber(n) : null;
    } catch {
      // Most SIMs simply don't have the MSISDN written to them.
    }

    return { imei, iccid, ownNumber };
  }

  /** ICCID-keyed labels win, then IMEI, then a generated fallback. */
  private resolveLabel(identity: ModemIdentity): string {
    if (identity.iccid && this.labels[identity.iccid]) return this.labels[identity.iccid]!;
    if (this.labels[identity.imei]) return this.labels[identity.imei]!;
    if (identity.ownNumber) return `SIM ${identity.ownNumber}`;
    if (identity.iccid) return `SIM …${identity.iccid.slice(-6)}`;
    return `SIM ${identity.imei.slice(-6)}`;
  }

  async status(): Promise<ModemStatus> {
    const safely = async <T>(cmd: string, parse: (lines: string[]) => T): Promise<T | null> => {
      try {
        return parse(await this.channel.execute(cmd, 8000));
      } catch (err) {
        this.log.debug({ cmd, err: (err as Error).message }, 'status command failed');
        return null;
      }
    };

    const [simState, signal, operator, registration, gprsRegistration, systemInfo, storage] =
      [
        await safely('AT+CPIN?', parseCpin),
        await safely('AT+CSQ', parseCsq),
        await safely('AT+COPS?', parseCops),
        await safely('AT+CREG?', (l) => parseCreg(l, 'CREG')),
        await safely('AT+CGREG?', (l) => parseCreg(l, 'CGREG')),
        await safely('AT+CPSI?', parseCpsi),
        await safely('AT+CPMS?', parseCpms),
      ];

    this.repo.touchModem(this.id);

    return {
      label: this.label,
      imei: this.identity.imei,
      iccid: this.identity.iccid,
      ownNumber: this.identity.ownNumber,
      devicePath: this.candidate.path,
      usbLocation: this.candidate.usbLocation,
      simState,
      signal,
      operator,
      registration,
      gprsRegistration,
      systemInfo,
      storage,
    };
  }

  /**
   * Cheap two-command snapshot for list rendering.
   *
   * `/select` renders one line per modem; a full status() would issue seven AT
   * commands per module and make the menu crawl once more than one is attached.
   */
  async summary(): Promise<{ carrier: string | null; bars: number }> {
    let carrier: string | null = null;
    let bars = 0;
    try {
      carrier = parseCops(await this.channel.execute('AT+COPS?', 5000))?.name ?? null;
    } catch {
      // Leave it blank rather than failing the whole menu.
    }
    try {
      bars = parseCsq(await this.channel.execute('AT+CSQ', 5000))?.bars ?? 0;
    } catch {
      // As above.
    }
    return { carrier, bars };
  }

  // ------------------------------------------------------- network selection

  /** Current carrier selection and radio preferences. */
  async networkConfig(): Promise<{
    operator: OperatorInfo | null;
    registration: RegistrationInfo | null;
    networkMode: { value: number; label: string } | null;
    lteMode: { value: number; label: string } | null;
    lastError: string | null;
  }> {
    const read = async <T>(cmd: string, parse: (l: string[]) => T): Promise<T | null> => {
      try {
        return parse(await this.channel.execute(cmd, 8000));
      } catch {
        return null;
      }
    };
    return {
      operator: await read('AT+COPS?', parseCops),
      registration: await read('AT+CREG?', (l) => parseCreg(l, 'CREG')),
      networkMode: await read('AT+CNMP?', parseCnmp),
      lteMode: await read('AT+CMNB?', parseCmnb),
      // Why the last attach attempt was refused, when it was.
      lastError: await read('AT+CEER', parseCeer),
    };
  }

  /**
   * Scan for visible networks.
   *
   * Slow (30-120s) and disruptive: the module drops its current registration for
   * the duration. The channel queue makes every other command on this modem wait,
   * which is why the timeout is generous.
   */
  async scanNetworks(): Promise<ScannedOperator[]> {
    // Report operators numerically so the PLMN is always present to select by.
    await this.channel.execute('AT+COPS=3,2').catch(() => undefined);
    return parseCopsScan(await this.channel.execute('AT+COPS=?', 180_000));
  }

  /**
   * Lock the modem to one carrier, optionally on a specific access technology.
   *
   * Uses mode 1 (manual, no fallback) rather than mode 4. Mode 4 would silently
   * revert to automatic when the chosen network refuses or is unreachable, which
   * destroys the answer being looked for: a selection that "succeeds" tells you
   * nothing if it may have fallen back. Mode 1 fails loudly instead.
   *
   * The consequence is that a failed selection leaves the module deregistered
   * rather than on some other network, and the lock persists across reboots.
   * `selectAutomaticNetwork()` is the only way out.
   */
  async selectNetwork(plmn: string, act?: number): Promise<void> {
    if (!/^\d{5,6}$/.test(plmn)) throw new Error(`"${plmn}" is not a numeric PLMN`);
    const suffix = act === undefined ? '' : `,${act}`;
    await this.channel.execute(`AT+COPS=1,2,"${plmn}"${suffix}`, 180_000);
  }

  /** Return to automatic carrier selection. */
  async selectAutomaticNetwork(): Promise<void> {
    await this.channel.execute('AT+COPS=0', 180_000);
  }

  /** `AT+CNMP` — which radio generations to try. Persists to NVM. */
  async setNetworkMode(value: number): Promise<void> {
    await this.channel.execute(`AT+CNMP=${value}`, 15_000);
  }

  /** `AT+CMNB` — Cat-M, NB-IoT, or both. Persists to NVM. */
  async setLteMode(value: number): Promise<void> {
    await this.channel.execute(`AT+CMNB=${value}`, 15_000);
  }

  /** Sends an SMS and records it. Throws if the modem rejects any segment. */
  async send(destination: string, text: string): Promise<SendResult> {
    const result = await sendSms(this.channel, this.log, destination, text);
    this.repo.insertOutbound({
      modemId: this.id,
      peerNumber: normaliseNumber(destination),
      text,
      encoding: result.encoding,
      parts: result.parts,
      mr: result.references[0] ?? null,
    });
    return result;
  }

  /** Periodic upkeep: catch missed URCs and time out stalled multiparts. */
  async poll(): Promise<void> {
    await this.receiver.drain();
    this.receiver.flushStaleConcat();
  }

  async close(): Promise<void> {
    await this.channel?.close();
  }
}
