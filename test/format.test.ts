import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus } from '../src/telegram/format.ts';
import type { ModemStatus } from '../src/modem/modem.ts';

const base: ModemStatus = {
  label: 'SIM A',
  imei: '867280069297869',
  iccid: '8914900010144783119',
  ownNumber: '+16479060432',
  devicePath: '/dev/ttyUSB2',
  usbLocation: '1-6.3.4.1',
  simState: 'READY',
  signal: { rssi: 20, dbm: -73, bars: 5, ber: null },
  operator: null,
  registration: null,
  gprsRegistration: null,
  systemInfo: null,
  storage: { used: 3, total: 30 },
};

const operator = (selectionMode: number) => ({
  name: 'Bell',
  accessTechnology: 'LTE-M',
  selectionMode,
  selectionModeLabel: selectionMode === 1 ? 'manual (locked)' : 'automatic',
});

const registration = (registered: boolean) => ({
  stat: registered ? 1 : 0,
  description: registered ? 'registered (home)' : 'not registered',
  roaming: false,
  registered,
});

describe('status formatting', () => {
  test('warns when the carrier is locked manually', () => {
    const out = formatStatus({ ...base, operator: operator(1), registration: registration(true) });
    assert.match(out, /Carrier locked manually/);
    assert.match(out, /network auto to release/);
  });

  test('calls out a lock that is also unregistered', () => {
    // The stuck state: a hard lock never retries elsewhere on its own.
    const out = formatStatus({ ...base, operator: operator(1), registration: registration(false) });
    assert.match(out, /Carrier locked manually — and not registered/);
  });

  test('stays quiet under automatic selection', () => {
    const out = formatStatus({ ...base, operator: operator(0), registration: registration(true) });
    assert.doesNotMatch(out, /locked/i);
  });

  test('flags nearly-full SMS storage', () => {
    const out = formatStatus({ ...base, storage: { used: 28, total: 30 } });
    assert.match(out, /28\/30 ⚠️/);
  });

  test('renders unknown signal without inventing a value', () => {
    const out = formatStatus({ ...base, signal: { rssi: 99, dbm: null, bars: 0, ber: null } });
    assert.match(out, /Signal: unknown/);
  });
});
