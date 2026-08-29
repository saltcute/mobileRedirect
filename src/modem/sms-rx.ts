import { EventEmitter } from 'node:events';
import smsPdu from 'node-sms-pdu';
import type { AtChannel } from './at-channel.js';
import type { Repo } from '../store/repo.js';
import type { Logger } from '../logger.js';
import { normaliseNumber, parseCmgl, parseCmgr, parseCmti } from './parse.js';

export interface IncomingSms {
  messageId: number;
  modemId: number;
  from: string;
  text: string;
  timestamp: string | null;
  parts: number;
}

export interface SmsReceiverOptions {
  channel: AtChannel;
  repo: Repo;
  modemId: number;
  logger: Logger;
  concatTimeoutMs: number;
}

/**
 * Pulls inbound SMS off a modem and reassembles multipart messages.
 *
 * Emits `sms` (IncomingSms) for each complete message.
 */
export class SmsReceiver extends EventEmitter {
  private readonly channel: AtChannel;
  private readonly repo: Repo;
  private readonly modemId: number;
  private readonly log: Logger;
  private readonly concatTimeoutMs: number;
  private draining = false;

  constructor(opts: SmsReceiverOptions) {
    super();
    this.channel = opts.channel;
    this.repo = opts.repo;
    this.modemId = opts.modemId;
    this.log = opts.logger;
    this.concatTimeoutMs = opts.concatTimeoutMs;

    this.channel.on('urc', (line: string) => {
      const cmti = parseCmti(line);
      if (cmti) {
        this.log.debug({ index: cmti.index, storage: cmti.storage }, 'new sms indicated');
        void this.readAndIngest(cmti.index);
      }
    });
  }

  /**
   * Read every message currently in SIM storage.
   *
   * Runs at startup (to collect anything that arrived while we were down) and
   * periodically, which also covers `+CMTI` URCs lost to a a transient channel
   * problem.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const lines = await this.channel.execute('AT+CMGL=4', 20_000);
      const stored = parseCmgl(lines);
      if (stored.length > 0) {
        this.log.info({ count: stored.length }, 'draining stored sms');
      }
      for (const item of stored) {
        await this.ingest(item.pduHex, item.index);
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'sms drain failed');
    } finally {
      this.draining = false;
    }
  }

  private async readAndIngest(index: number): Promise<void> {
    try {
      const lines = await this.channel.execute(`AT+CMGR=${index}`, 15_000);
      const result = parseCmgr(lines);
      if (!result) {
        this.log.warn({ index }, 'CMGR returned no PDU');
        return;
      }
      await this.ingest(result.pduHex, index);
    } catch (err) {
      this.log.warn({ index, err: (err as Error).message }, 'failed to read sms');
    }
  }

  /**
   * Parse, persist, then free the SIM slot.
   *
   * Order matters: the message is durable before `AT+CMGD` runs, so a crash in
   * between costs a duplicate (which the dedupe index absorbs) rather than the
   * message itself. Deleting is mandatory — SIM storage holds only ~20-30
   * messages and the modem silently stops accepting new ones once it is full.
   */
  private async ingest(pduHex: string, index: number): Promise<void> {
    let completed: IncomingSms | null = null;
    try {
      completed = this.persist(pduHex);
    } catch (err) {
      this.log.error({ index, err: (err as Error).message }, 'failed to persist sms');
      // Leave the slot alone so the message isn't lost; the next drain retries.
      return;
    }

    await this.deleteFromSim(index);
    if (completed) this.emit('sms', completed);
  }

  private async deleteFromSim(index: number): Promise<void> {
    try {
      await this.channel.execute(`AT+CMGD=${index}`, 10_000);
    } catch (err) {
      this.log.warn({ index, err: (err as Error).message }, 'failed to delete sms from SIM');
    }
  }

  /** Returns a complete message, or null when the PDU was a partial/dup/unusable. */
  private persist(pduHex: string): IncomingSms | null {
    const parsed = smsPdu.parse(pduHex);

    if ('error' in parsed && parsed.error) {
      this.log.warn({ err: parsed.error.message, pduHex }, 'unparseable PDU, discarding');
      return null;
    }
    if (parsed.type !== 'SMS-DELIVER') {
      this.log.debug({ type: parsed.type }, 'ignoring non-DELIVER PDU');
      return null;
    }

    const from = normaliseNumber(parsed.origination ?? 'unknown');
    const text = parsed.text ?? '';
    const timestamp = parsed.timestamp;

    if (!parsed.concat) {
      return this.store(from, text, timestamp, 1);
    }

    const { reference, total, sequence } = parsed.concat;
    const held = this.repo.addConcatPart({
      modemId: this.modemId,
      sender: from,
      reference,
      total,
      sequence,
      text,
      smsTimestamp: timestamp,
    });

    if (held.length < total) {
      this.log.debug(
        { from, reference, have: held.length, total },
        'holding partial multipart sms',
      );
      return null;
    }

    this.repo.clearConcat(this.modemId, from, reference);
    const joined = held.map((p) => p.text).join('');
    // Segments carry near-identical SCTS values; the first is the arrival time.
    const firstTs = held[0]?.sms_timestamp ?? timestamp;
    return this.store(from, joined, firstTs, total);
  }

  private store(
    from: string,
    text: string,
    timestamp: string | null,
    parts: number,
  ): IncomingSms | null {
    const messageId = this.repo.insertInbound({
      modemId: this.modemId,
      peerNumber: from,
      text,
      smsTimestamp: timestamp,
      parts,
    });

    if (messageId === null) {
      this.log.info({ from }, 'duplicate sms suppressed');
      return null;
    }
    return { messageId, modemId: this.modemId, from, text, timestamp, parts };
  }

  /**
   * Flush multipart groups whose remaining segments never arrived, so a lost
   * segment can't strand the text that did turn up.
   */
  flushStaleConcat(): void {
    const cutoff = Date.now() - this.concatTimeoutMs;
    for (const group of this.repo.staleConcatGroups(cutoff)) {
      if (group.modem_id !== this.modemId) continue;
      const parts = this.repo.getConcatParts(group.modem_id, group.sender, group.reference);
      if (parts.length === 0) continue;

      this.repo.clearConcat(group.modem_id, group.sender, group.reference);
      const joined = parts.map((p) => p.text).join('');
      const marker = `${joined}\n\n[incomplete: ${parts.length}/${group.total} parts received]`;
      const stored = this.store(
        group.sender,
        marker,
        parts[0]?.sms_timestamp ?? null,
        parts.length,
      );
      this.log.warn(
        { from: group.sender, have: parts.length, total: group.total },
        'flushed incomplete multipart sms',
      );
      if (stored) this.emit('sms', stored);
    }
  }
}
