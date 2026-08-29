import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import smsPdu from 'node-sms-pdu';
import { sendSms } from '../src/modem/sms-tx.ts';

const silent = pino({ level: 'silent' });

interface Submitted {
  length: number;
  hex: string;
}

function fakeChannel(): { channel: never; submitted: Submitted[] } {
  const submitted: Submitted[] = [];
  const channel = {
    submitPdu(length: number, hex: string): Promise<string[]> {
      submitted.push({ length, hex });
      return Promise.resolve([`+CMGS: ${submitted.length}`]);
    },
  };
  return { channel: channel as never, submitted };
}

describe('sendSms', () => {
  test('sends a short GSM-7 message as one part', async () => {
    const { channel, submitted } = fakeChannel();
    const result = await sendSms(channel, silent, '+4915112345678', 'Hello there');

    assert.equal(result.parts, 1);
    assert.equal(result.encoding, 'gsm');
    assert.equal(submitted.length, 1);
    assert.deepEqual(result.references, [1]);
  });

  test('selects UCS-2 for non-GSM characters', async () => {
    const { channel } = fakeChannel();
    const result = await sendSms(channel, silent, '+4915112345678', 'Grüße 😀');
    assert.equal(result.encoding, 'ucs2');
  });

  test('segments a long message and submits every part', async () => {
    const { channel, submitted } = fakeChannel();
    // Past 160 GSM-7 characters the message must be split with a UDH.
    const long = 'A'.repeat(400);
    const result = await sendSms(channel, silent, '+4915112345678', long);

    assert.ok(result.parts > 1, 'a 400-character message must span parts');
    assert.equal(submitted.length, result.parts, 'every part must be submitted');
    assert.equal(result.references.length, result.parts);
  });

  test('keeps GSM-7 for accented Latin, which is in the GSM alphabet', async () => {
    const { channel } = fakeChannel();
    // ü is a GSM 03.38 character, so this stays single-part at the 160 limit.
    const result = await sendSms(channel, silent, '+4915112345678', 'ü'.repeat(100));
    assert.equal(result.encoding, 'gsm');
    assert.equal(result.parts, 1);
  });

  test('segments at the documented single-message boundaries', async () => {
    const at = async (text: string) => {
      const { channel } = fakeChannel();
      return sendSms(channel, silent, '+4915112345678', text);
    };

    // GSM-7 fits 160 in one part; UCS-2 fits 70.
    assert.equal((await at('A'.repeat(160))).parts, 1);
    assert.equal((await at('A'.repeat(161))).parts, 2);
    assert.equal((await at('日'.repeat(70))).parts, 1);
    assert.equal((await at('日'.repeat(71))).parts, 2);
  });

  test('passes the TPDU length, not the hex byte count, to AT+CMGS', async () => {
    const { channel, submitted } = fakeChannel();
    await sendSms(channel, silent, '+4915112345678', 'Hello there');

    const expected = smsPdu.generateSubmit('+4915112345678', 'Hello there');
    assert.equal(submitted[0]?.length, expected[0]?.length);
    // The two differ because `length` excludes the SCA byte; sending hex.length/2
    // makes the modem reject the PDU or truncate it.
    assert.notEqual(submitted[0]?.length, (submitted[0]?.hex.length ?? 0) / 2);
  });

  test('rejects an invalid destination before touching the modem', async () => {
    const { channel, submitted } = fakeChannel();
    await assert.rejects(sendSms(channel, silent, 'not-a-number', 'hi'));
    assert.equal(submitted.length, 0);
  });
});
