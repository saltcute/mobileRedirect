import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import type { Logger } from '../logger.js';

/** Terminates a command with success. */
const OK = /^OK$/;
/** Terminates a command with failure. */
const ERROR_PATTERNS = [
  /^ERROR$/,
  /^\+CME ERROR:\s*(.+)$/,
  /^\+CMS ERROR:\s*(.+)$/,
  /^ABORTED$/,
];

/**
 * Lines that are *never* a reply to a command we issue, so they can be routed to
 * the URC bus even while a command is in flight.
 *
 * Deliberately excludes ambiguous prefixes like `+CPIN:` and `+CREG:`, which are
 * both URCs and query replies. Those are treated as command output whenever a
 * command is pending, and as a URC otherwise — see `isUnsolicited`.
 */
const HARD_URC_PREFIXES = [
  '+CMTI:',
  '+CMT:',
  '+CDS:',
  '+CDSI:',
  '+CBM:',
  '+CBMI:',
  '*PSNWID:',
  '*PSUTTZ:',
  '+CTZV:',
  'DST:',
  'RING',
  'NO CARRIER',
  'NO ANSWER',
  'BUSY',
  'SMS Ready',
  'SMS DONE',
  'PB DONE',
  'RDY',
  'NORMAL POWER DOWN',
  'UNDER-VOLTAGE',
  'OVER-VOLTAGE',
];

/** Prefixes that are URCs only when no command is awaiting a reply. */
const SOFT_URC_PREFIXES = ['+CPIN:', '+CREG:', '+CGREG:', '+CEREG:'];

export class AtError extends Error {
  readonly command: string;
  readonly code: string | undefined;

  constructor(message: string, command: string, code?: string) {
    super(message);
    this.name = 'AtError';
    this.command = command;
    this.code = code;
  }
}

export class AtTimeoutError extends AtError {
  constructor(command: string, ms: number) {
    super(`Command ${JSON.stringify(command)} timed out after ${ms}ms`, command);
    this.name = 'AtTimeoutError';
  }
}

interface Pending {
  command: string;
  lines: string[];
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PromptWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AtChannelOptions {
  path: string;
  baudRate?: number;
  logger: Logger;
  /** Test seam: inject a mock serial binding. Production leaves this unset. */
  binding?: unknown;
}

/**
 * A serialised AT command channel over one serial port.
 *
 * Only one command occupies the channel at a time; callers queue behind each
 * other. Unsolicited result codes (URCs) are emitted as `urc` events and never
 * leak into a pending command's response.
 */
export class AtChannel extends EventEmitter {
  private readonly port: SerialPort;
  private readonly log: Logger;
  /** Bytes received but not yet forming a complete line. */
  private rxBuffer = '';
  private pending: Pending | null = null;
  private promptWaiter: PromptWaiter | null = null;
  /** Tail of the command queue; every job chains off this. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(opts: AtChannelOptions) {
    super();
    this.log = opts.logger.child({ port: opts.path });
    this.port = new SerialPort({
      path: opts.path,
      baudRate: opts.baudRate ?? 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      // The SIM7070 USB ACM endpoint ignores hardware flow control; enabling it
      // on a port with no RTS/CTS lines wedges writes.
      rtscts: false,
      autoOpen: false,
      ...(opts.binding ? { binding: opts.binding } : {}),
    } as ConstructorParameters<typeof SerialPort>[0]);

    this.port.on('data', (chunk: Buffer) => this.onData(chunk));
    this.port.on('error', (err) => this.onFailure(err));
    this.port.on('close', () => this.onFailure(new Error('serial port closed')));
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.port.isOpen) {
      await new Promise<void>((resolve) => this.port.close(() => resolve()));
    }
  }

  get isOpen(): boolean {
    return this.port.isOpen && !this.closed;
  }

  // ---------------------------------------------------------------- receiving

  private onData(chunk: Buffer): void {
    this.rxBuffer += chunk.toString('binary');

    // Drain complete lines first.
    let idx: number;
    while ((idx = this.rxBuffer.indexOf('\r\n')) !== -1) {
      const line = this.rxBuffer.slice(0, idx);
      this.rxBuffer = this.rxBuffer.slice(idx + 2);
      const trimmed = line.trim();
      if (trimmed.length > 0) this.onLine(trimmed);
    }

    // TRAP: the `AT+CMGS` send prompt is `\r\n> ` with NO trailing newline, so it
    // never appears as a "line". It only ever shows up as leftover in the buffer,
    // which is why the prompt check lives here and not in onLine().
    if (this.promptWaiter && /^>\s*$/.test(this.rxBuffer)) {
      this.rxBuffer = '';
      const waiter = this.promptWaiter;
      this.promptWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private onLine(line: string): void {
    this.log.trace({ rx: line }, 'at rx');

    if (this.isUnsolicited(line)) {
      this.emit('urc', line);
      return;
    }

    const pending = this.pending;
    if (!pending) {
      // No command in flight and not a recognised URC — still surface it rather
      // than dropping silently; firmware emits assorted boot chatter.
      this.emit('urc', line);
      return;
    }

    if (OK.test(line)) {
      this.settle(pending, null);
      return;
    }
    for (const pattern of ERROR_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        this.settle(
          pending,
          new AtError(
            `Command ${JSON.stringify(pending.command)} failed: ${line}`,
            pending.command,
            m[1]?.trim(),
          ),
        );
        return;
      }
    }
    pending.lines.push(line);
  }

  private isUnsolicited(line: string): boolean {
    if (HARD_URC_PREFIXES.some((p) => line.startsWith(p))) return true;
    if (!this.pending && SOFT_URC_PREFIXES.some((p) => line.startsWith(p))) return true;
    return false;
  }

  private settle(pending: Pending, err: Error | null): void {
    this.pending = null;
    clearTimeout(pending.timer);
    if (err) pending.reject(err);
    else pending.resolve(pending.lines);
  }

  private onFailure(err: Error): void {
    if (this.pending) this.settle(this.pending, err);
    if (this.promptWaiter) {
      clearTimeout(this.promptWaiter.timer);
      this.promptWaiter.reject(err);
      this.promptWaiter = null;
    }
    if (!this.closed) {
      this.closed = true;
      this.log.warn({ err: err.message }, 'channel failed');
      this.emit('failed', err);
    }
  }

  // ------------------------------------------------------------------ sending

  private write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port.isOpen) return reject(new Error('serial port is not open'));
      this.port.write(Buffer.from(data, 'binary'), (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Serialises jobs so no two commands can interleave on the wire. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job, job);
    // Swallow rejections on the chain itself so one failure doesn't poison the
    // queue for every subsequent caller.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private awaitResponse(command: string, timeoutMs: number): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.command === command) {
          this.pending = null;
          reject(new AtTimeoutError(command, timeoutMs));
        }
      }, timeoutMs);
      this.pending = { command, lines: [], resolve, reject, timer };
    });
  }

  private awaitPrompt(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.promptWaiter = null;
        reject(new Error(`Timed out waiting for the '>' send prompt`));
      }, timeoutMs);
      this.promptWaiter = { resolve, reject, timer };
    });
  }

  /**
   * Issue a command and collect its intermediate lines. Resolves on `OK`,
   * rejects on `ERROR` / `+CME ERROR` / `+CMS ERROR` / timeout.
   */
  execute(command: string, timeoutMs = 10_000): Promise<string[]> {
    return this.run(async () => {
      this.log.trace({ tx: command }, 'at tx');
      const responsePromise = this.awaitResponse(command, timeoutMs);
      await this.write(`${command}\r`);
      return responsePromise;
    });
  }

  /**
   * Two-phase PDU submit: `AT+CMGS=<length>`, wait for the bare `>` prompt, then
   * write the PDU hex terminated by Ctrl-Z.
   *
   * Returns the raw response lines (containing `+CMGS: <mr>`).
   */
  submitPdu(
    tpduLength: number,
    pduHex: string,
    timeoutMs = 60_000,
    promptTimeoutMs = 15_000,
  ): Promise<string[]> {
    return this.run(async () => {
      const command = `AT+CMGS=${tpduLength}`;
      this.log.trace({ tx: command }, 'at tx (pdu submit)');

      const promptPromise = this.awaitPrompt(promptTimeoutMs);
      await this.write(`${command}\r`);

      try {
        await promptPromise;
      } catch (err) {
        // TRAP: if the prompt never came the modem may still be waiting for
        // payload. ESC aborts the pending submit; without it every subsequent
        // command on this channel would be swallowed as SMS body text.
        this.log.warn('no send prompt — aborting with ESC');
        await this.write('\x1b').catch(() => undefined);
        throw err;
      }

      const responsePromise = this.awaitResponse(command, timeoutMs);
      await this.write(`${pduHex}\x1a`);
      return responsePromise;
    });
  }
}
