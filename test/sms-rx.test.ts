import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { openDatabase } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { SmsReceiver, type IncomingSms } from '../src/modem/sms-rx.ts';
import { buildDeliverPdu } from './pdu-fixtures.ts';

const silent = pino({ level: 'silent' });
const SENDER = '+4915112345678';

/** Stands in for AtChannel: records commands, answers from a canned map. */
class FakeChannel extends EventEmitter {
  commands: string[] = [];
  stored = new Map<number, string>();

  execute(command: string): Promise<string[]> {
    this.commands.push(command);

    if (command === 'AT+CMGL=4') {
      const lines: string[] = [];
      for (const [index, pdu] of this.stored) {
        lines.push(`+CMGL: ${index},0,,${pdu.length / 2}`, pdu);
      }
      return Promise.resolve(lines);
    }
    const read = /^AT\+CMGR=(\d+)$/.exec(command);
    if (read) {
      const pdu = this.stored.get(Number(read[1]));
      if (!pdu) return Promise.reject(new Error('no such index'));
      return Promise.resolve([`+CMGR: 0,,${pdu.length / 2}`, pdu]);
    }
    const del = /^AT\+CMGD=(\d+)$/.exec(command);
    if (del) {
      this.stored.delete(Number(del[1]));
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }

  deleted(index: number): boolean {
    return this.commands.includes(`AT+CMGD=${index}`);
  }
}

function harness(concatTimeoutMs = 300_000) {
  const db = openDatabase(':memory:');
  const repo = new Repo(db);
  const modemId = repo.upsertModem({
    imei: '867584031234567',
    iccid: '8949012345678901234',
    label: 'Test SIM',
    ownNumber: null,
    usbLocation: '1-1',
  });
  const channel = new FakeChannel();
  const received: IncomingSms[] = [];
  const receiver = new SmsReceiver({
    channel: channel as never,
    repo,
    modemId,
    logger: silent,
    concatTimeoutMs,
  });
  receiver.on('sms', (sms: IncomingSms) => received.push(sms));
  return { db, repo, channel, receiver, received, modemId };
}

describe('SmsReceiver', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  test('ingests a single message and frees the SIM slot', async () => {
    h.channel.stored.set(1, buildDeliverPdu({ from: SENDER, text: 'Hallo Welt' }));
    await h.receiver.drain();

    assert.equal(h.received.length, 1);
    assert.equal(h.received[0]?.from, SENDER);
    assert.equal(h.received[0]?.text, 'Hallo Welt');
    assert.ok(h.channel.deleted(1), 'message must be deleted from the SIM');
  });

  test('decodes non-GSM text', async () => {
    h.channel.stored.set(1, buildDeliverPdu({ from: SENDER, text: 'Grüße 😀 日本' }));
    await h.receiver.drain();
    assert.equal(h.received[0]?.text, 'Grüße 😀 日本');
  });

  test('reassembles a multipart message', async () => {
    h.channel.stored.set(
      1,
      buildDeliverPdu({
        from: SENDER,
        text: 'First half ',
        concat: { reference: 88, total: 2, sequence: 1 },
      }),
    );
    h.channel.stored.set(
      2,
      buildDeliverPdu({
        from: SENDER,
        text: 'second half',
        concat: { reference: 88, total: 2, sequence: 2 },
      }),
    );

    await h.receiver.drain();

    assert.equal(h.received.length, 1, 'segments must surface as one message');
    assert.equal(h.received[0]?.text, 'First half second half');
    assert.equal(h.received[0]?.parts, 2);
  });

  test('reassembles in sequence order regardless of arrival order', async () => {
    // Segment 2 lands first — the network makes no ordering guarantee.
    h.channel.stored.set(
      5,
      buildDeliverPdu({
        from: SENDER,
        text: 'second half',
        concat: { reference: 88, total: 2, sequence: 2 },
      }),
    );
    await h.receiver.drain();
    assert.equal(h.received.length, 0, 'must wait for the missing segment');

    h.channel.stored.set(
      6,
      buildDeliverPdu({
        from: SENDER,
        text: 'First half ',
        concat: { reference: 88, total: 2, sequence: 1 },
      }),
    );
    await h.receiver.drain();

    assert.equal(h.received.length, 1);
    assert.equal(h.received[0]?.text, 'First half second half');
  });

  test('keeps concurrent multipart messages from different senders separate', async () => {
    const other = '+4930111222';
    h.channel.stored.set(
      1,
      buildDeliverPdu({
        from: SENDER,
        text: 'AAA',
        concat: { reference: 7, total: 2, sequence: 1 },
      }),
    );
    h.channel.stored.set(
      2,
      buildDeliverPdu({
        from: other,
        // Same reference number, different sender — must not be merged.
        text: 'BBB',
        concat: { reference: 7, total: 2, sequence: 1 },
      }),
    );
    h.channel.stored.set(
      3,
      buildDeliverPdu({
        from: SENDER,
        text: 'ZZZ',
        concat: { reference: 7, total: 2, sequence: 2 },
      }),
    );

    await h.receiver.drain();

    assert.equal(h.received.length, 1);
    assert.equal(h.received[0]?.from, SENDER);
    assert.equal(h.received[0]?.text, 'AAAZZZ');
  });

  test('flushes an incomplete multipart once it goes stale', async () => {
    const stale = harness(1);
    stale.repo.addConcatPart({
      modemId: stale.modemId,
      sender: SENDER,
      reference: 42,
      total: 3,
      sequence: 1,
      text: 'only the first part',
      smsTimestamp: '2024-01-15T12:30:45+00:00',
    });

    // Let the segment age past the (1ms) window.
    await new Promise((r) => setTimeout(r, 10));
    stale.receiver.flushStaleConcat();

    assert.equal(stale.received.length, 1);
    assert.match(stale.received[0]!.text, /^only the first part/);
    assert.match(stale.received[0]!.text, /incomplete: 1\/3 parts/);
  });

  test('does not flush a multipart that is still within its window', () => {
    h.repo.addConcatPart({
      modemId: h.modemId,
      sender: SENDER,
      reference: 42,
      total: 2,
      sequence: 1,
      text: 'recent',
      smsTimestamp: null,
    });
    h.receiver.flushStaleConcat();
    assert.equal(h.received.length, 0);
  });

  test('suppresses a message replayed after a crash between persist and delete', async () => {
    const pdu = buildDeliverPdu({ from: SENDER, text: 'Only once please' });
    h.channel.stored.set(1, pdu);
    await h.receiver.drain();
    assert.equal(h.received.length, 1);

    // Simulate the crash window: the same message is still in SIM storage.
    h.channel.stored.set(1, pdu);
    await h.receiver.drain();

    assert.equal(h.received.length, 1, 'duplicate must not reach Telegram');
    assert.ok(h.channel.deleted(1), 'but the slot must still be reclaimed');
  });

  test('reads and deletes on a +CMTI indication', async () => {
    h.channel.stored.set(4, buildDeliverPdu({ from: SENDER, text: 'Ping' }));
    h.channel.emit('urc', '+CMTI: "SM",4');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.received.length, 1);
    assert.equal(h.received[0]?.text, 'Ping');
    assert.ok(h.channel.commands.includes('AT+CMGR=4'));
    assert.ok(h.channel.deleted(4));
  });

  test('discards an unparseable PDU but still frees the slot', async () => {
    h.channel.stored.set(9, 'DEADBEEF');
    await h.receiver.drain();

    assert.equal(h.received.length, 0);
    assert.ok(h.channel.deleted(9), 'a bad PDU must not wedge SIM storage forever');
  });
});
