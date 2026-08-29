import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';

function setup() {
  const repo = new Repo(openDatabase(':memory:'));
  const modemId = repo.upsertModem({
    imei: '867584031234567',
    iccid: '8949012345678901234',
    label: 'SIM A',
    ownNumber: null,
    usbLocation: '1-1',
  });
  return { repo, modemId };
}

describe('Repo', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  test('upsert is idempotent on IMEI and refreshes the label', () => {
    const again = h.repo.upsertModem({
      imei: '867584031234567',
      iccid: '8949012345678901234',
      label: 'Renamed',
      ownNumber: '+4915112345678',
      usbLocation: '1-2',
    });
    assert.equal(again, h.modemId, 'same IMEI must map to one row');
    assert.equal(h.repo.listModems().length, 1);
    assert.equal(h.repo.getModem(h.modemId)?.label, 'Renamed');
  });

  test('treats two modules with identical USB serials as distinct', () => {
    // Every SIM7070G reports the same placeholder USB iSerial, so IMEI is the
    // only thing that separates them.
    const second = h.repo.upsertModem({
      imei: '867584039999999',
      iccid: '8949019999999999999',
      label: 'SIM B',
      ownNumber: null,
      usbLocation: '1-2',
    });
    assert.notEqual(second, h.modemId);
    assert.equal(h.repo.listModems().length, 2);
  });

  test('dedupes an inbound message replayed with the same timestamp', () => {
    const first = h.repo.insertInbound({
      modemId: h.modemId,
      peerNumber: '+4930111222',
      text: 'Same text',
      smsTimestamp: '2024-01-15T12:30:45+00:00',
    });
    const replay = h.repo.insertInbound({
      modemId: h.modemId,
      peerNumber: '+4930111222',
      text: 'Same text',
      smsTimestamp: '2024-01-15T12:30:45+00:00',
    });
    assert.ok(first);
    assert.equal(replay, null);
    assert.equal(h.repo.recentMessages(h.modemId, 10).length, 1);
  });

  test('keeps identical texts sent at different times', () => {
    const a = h.repo.insertInbound({
      modemId: h.modemId,
      peerNumber: '+4930111222',
      text: 'ping',
      smsTimestamp: '2024-01-15T12:30:45+00:00',
    });
    const b = h.repo.insertInbound({
      modemId: h.modemId,
      peerNumber: '+4930111222',
      text: 'ping',
      smsTimestamp: '2024-01-15T12:31:02+00:00',
    });
    assert.ok(a && b);
    assert.equal(h.repo.recentMessages(h.modemId, 10).length, 2);
  });

  test('never dedupes outbound messages', () => {
    for (let i = 0; i < 3; i++) {
      h.repo.insertOutbound({
        modemId: h.modemId,
        peerNumber: '+4930111222',
        text: 'ok',
        encoding: 'gsm',
        parts: 1,
        mr: i,
      });
    }
    assert.equal(h.repo.recentMessages(h.modemId, 10).length, 3);
  });

  test('resolves a swipe-reply back to the sender and receiving modem', () => {
    const messageId = h.repo.insertInbound({
      modemId: h.modemId,
      peerNumber: '+4930111222',
      text: 'Your code is 449812',
      smsTimestamp: '2024-01-15T12:30:45+00:00',
    })!;
    h.repo.mapTelegramMessage(-100123, 5678, messageId);

    const found = h.repo.lookupTelegramMessage(-100123, 5678);
    assert.equal(found?.peer_number, '+4930111222');
    assert.equal(found?.modem_id, h.modemId);

    assert.equal(h.repo.lookupTelegramMessage(-100123, 9999), null);
    assert.equal(h.repo.lookupTelegramMessage(-999, 5678), null, 'chat-scoped');
  });

  test('remembers the selected SIM per chat', () => {
    assert.equal(h.repo.getSelectedModem(42), null);
    h.repo.setSelectedModem(42, h.modemId);
    assert.equal(h.repo.getSelectedModem(42), h.modemId);

    const other = h.repo.upsertModem({
      imei: '867584039999999',
      iccid: null,
      label: 'SIM B',
      ownNumber: null,
      usbLocation: '1-2',
    });
    h.repo.setSelectedModem(42, other);
    assert.equal(h.repo.getSelectedModem(42), other);
    assert.equal(h.repo.getSelectedModem(43), null, 'other chats are unaffected');
  });

  test('history is newest-first and bounded', () => {
    for (let i = 0; i < 5; i++) {
      h.repo.insertOutbound({
        modemId: h.modemId,
        peerNumber: '+49301',
        text: `msg ${i}`,
        encoding: 'gsm',
        parts: 1,
        mr: i,
      });
    }
    const recent = h.repo.recentMessages(h.modemId, 3);
    assert.equal(recent.length, 3);
    assert.equal(recent[0]?.text, 'msg 4');
  });
});
