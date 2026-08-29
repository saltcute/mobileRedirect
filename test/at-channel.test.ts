import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { MockBinding } from '@serialport/binding-mock';
import { AtChannel, AtError } from '../src/modem/at-channel.ts';

const silent = pino({ level: 'silent' });

/** Lets pending I/O settle before asserting on it. */
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let counter = 0;

async function makeChannel(): Promise<{
  channel: AtChannel;
  emit: (data: string) => void;
  written: () => string;
}> {
  const path = `/dev/mock${counter++}`;
  MockBinding.createPort(path, { echo: false, record: true });
  const channel = new AtChannel({ path, logger: silent, binding: MockBinding });
  await channel.open();

  // Reaching into the binding is deliberate: it is the only way to drive a mock
  // serial device, and keeps the test seam out of the production interface.
  const mock = (channel as unknown as { port: { port: MockPort } }).port.port;
  return {
    channel,
    emit: (data: string) => mock.emitData(Buffer.from(data, 'binary')),
    written: () => mock.recording.toString('binary'),
  };
}

interface MockPort {
  emitData: (b: Buffer) => void;
  recording: Buffer;
}

describe('AtChannel', () => {
  before(() => MockBinding.reset());
  afterEach(() => tick(1));

  test('collects intermediate lines and resolves on OK', async () => {
    const { channel, emit, written } = await makeChannel();
    const pending = channel.execute('AT+CSQ');

    await tick();
    assert.equal(written(), 'AT+CSQ\r', 'command is CR-terminated');

    emit('\r\n+CSQ: 22,0\r\n\r\nOK\r\n');
    assert.deepEqual(await pending, ['+CSQ: 22,0']);
    await channel.close();
  });

  test('rejects on +CME ERROR and surfaces the cause', async () => {
    const { channel, emit } = await makeChannel();
    const pending = channel.execute('AT+CPIN?');

    await tick();
    emit('\r\n+CME ERROR: SIM not inserted\r\n');

    await assert.rejects(pending, (err: AtError) => {
      assert.equal(err.name, 'AtError');
      assert.equal(err.code, 'SIM not inserted');
      return true;
    });
    await channel.close();
  });

  test('rejects on bare ERROR', async () => {
    const { channel, emit } = await makeChannel();
    const pending = channel.execute('AT+NOPE');
    await tick();
    emit('\r\nERROR\r\n');
    await assert.rejects(pending, /failed/);
    await channel.close();
  });

  test('routes a URC arriving mid-command to the URC bus, not the response', async () => {
    const { channel, emit } = await makeChannel();
    const urcs: string[] = [];
    channel.on('urc', (line: string) => urcs.push(line));

    const pending = channel.execute('AT+CSQ');
    await tick();
    // An SMS lands while the query is still in flight.
    emit('\r\n+CMTI: "SM",3\r\n');
    emit('\r\n+CSQ: 18,0\r\n\r\nOK\r\n');

    const lines = await pending;
    assert.deepEqual(lines, ['+CSQ: 18,0'], 'URC must not pollute the response');
    assert.deepEqual(urcs, ['+CMTI: "SM",3']);
    await channel.close();
  });

  test('emits URCs arriving while the channel is idle', async () => {
    const { channel, emit } = await makeChannel();
    const urcs: string[] = [];
    channel.on('urc', (line: string) => urcs.push(line));

    emit('\r\n+CMTI: "SM",1\r\nSMS Ready\r\n');
    await tick();

    assert.deepEqual(urcs, ['+CMTI: "SM",1', 'SMS Ready']);
    await channel.close();
  });

  test('detects the newline-less send prompt and completes a PDU submit', async () => {
    const { channel, emit, written } = await makeChannel();
    const pending = channel.submitPdu(20, 'ABCD1234');

    await tick();
    assert.equal(written(), 'AT+CMGS=20\r');

    // The real modem sends this with no trailing newline, so it never forms a
    // "line" — the prompt must be detected from the raw buffer.
    emit('\r\n> ');
    await tick();
    assert.ok(
      written().endsWith('ABCD1234\x1a'),
      `payload should be Ctrl-Z terminated, got ${JSON.stringify(written())}`,
    );

    emit('\r\n+CMGS: 42\r\n\r\nOK\r\n');
    assert.deepEqual(await pending, ['+CMGS: 42']);
    await channel.close();
  });

  test('sends ESC to abort when the send prompt never arrives', async () => {
    const { channel, written } = await makeChannel();
    const pending = channel.submitPdu(20, 'ABCD', 60_000, 30);

    await assert.rejects(pending, /send prompt/);
    // Without the ESC the modem keeps waiting for payload and swallows every
    // subsequent command as message body.
    assert.ok(written().endsWith('\x1b'), 'must abort the pending submit with ESC');
    await channel.close();
  });

  test('serialises queued commands so they cannot interleave', async () => {
    const { channel, emit, written } = await makeChannel();

    const first = channel.execute('AT+ONE');
    const second = channel.execute('AT+TWO');

    await tick();
    assert.equal(written(), 'AT+ONE\r', 'second command must wait its turn');

    emit('\r\nOK\r\n');
    await first;
    await tick();
    assert.equal(written(), 'AT+ONE\rAT+TWO\r');

    emit('\r\nOK\r\n');
    await second;
    await channel.close();
  });

  test('a failed command does not poison the queue', async () => {
    const { channel, emit } = await makeChannel();

    const failing = channel.execute('AT+BAD');
    await tick();
    emit('\r\nERROR\r\n');
    await assert.rejects(failing);

    const ok = channel.execute('AT+GOOD');
    await tick();
    emit('\r\n+GOOD: 1\r\n\r\nOK\r\n');
    assert.deepEqual(await ok, ['+GOOD: 1']);
    await channel.close();
  });

  test('times out a command that is never answered', async () => {
    const { channel } = await makeChannel();
    await assert.rejects(channel.execute('AT+SILENT', 40), /timed out/);
    await channel.close();
  });
});
