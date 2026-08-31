import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as alerts from '../src/telegram/alerts.ts';

describe('alerts — severity', () => {
  test('a startup that found modems is routine; one that found none is not', () => {
    // The empty case carries the failure, so hiding it behind `normal` would
    // make `critical` — the level you pick to hear only about breakage — silent
    // about a gateway that came up dead.
    assert.equal(alerts.started([{ label: 'A', devicePath: '/dev/ttyUSB2' }], null).level, 'normal');
    assert.equal(alerts.started([], 'no SIMCom module is attached').level, 'critical');
  });

  test('the empty startup message names the scan reason', () => {
    const { text } = alerts.started([], 'no AT port is bound');
    assert.match(text, /no AT port is bound/);
  });

  test('losing a module is critical; a port merely closing is not', () => {
    assert.equal(alerts.detached('A', 'vanished').level, 'critical');
    assert.equal(alerts.detached('A', 'channel-lost').level, 'critical');
    assert.equal(alerts.detached('A', 'port-closed').level, 'verbose');
  });

  test('a SIM going away or locking is critical; arriving is routine', () => {
    const ready = { kind: 'ready', detail: 'READY' } as const;
    const absent = { kind: 'absent', detail: 'not inserted' } as const;
    assert.equal(alerts.simChanged('A', ready, absent).level, 'critical');
    assert.equal(alerts.simChanged('A', ready, { kind: 'locked', detail: 'SIM PIN' }).level, 'critical');
    assert.equal(alerts.simChanged('A', absent, ready).level, 'normal');
  });

  test('a PUK lock carries the warning that guessing destroys the SIM', () => {
    const pin = alerts.simChanged('A', null, { kind: 'locked', detail: 'SIM PIN' });
    const puk = alerts.simChanged('A', null, { kind: 'locked', detail: 'SIM PUK' });
    assert.doesNotMatch(pin.text, /permanently/);
    assert.match(puk.text, /permanently kills the SIM/);
  });
});

describe('alerts — throttle keys', () => {
  test('repeatable causes carry a key, one-off transitions do not', () => {
    assert.ok(alerts.attachFailed('/dev/ttyUSB2', '1-6.3.4.1', 'e', null).key);
    assert.ok(alerts.scanEmpty('r').key);
    assert.ok(alerts.pollFailing('A', 3, 'e').key);
    assert.ok(alerts.unauthorised(1, 'u', 2).key);
    assert.equal(alerts.attached('A', '/dev/ttyUSB2', null).key, undefined);
    assert.equal(alerts.detached('A', 'vanished').key, undefined);
    assert.equal(alerts.signalLow('A', 1).key, undefined);
  });

  test('keys separate distinct slots and users', () => {
    assert.notEqual(
      alerts.attachFailed('/dev/ttyUSB2', '1-6.3.4.1', 'e', null).key,
      alerts.attachFailed('/dev/ttyUSB5', '1-6.3.4.2', 'e', null).key,
    );
    assert.notEqual(alerts.unauthorised(1, 'a', 0).key, alerts.unauthorised(2, 'b', 0).key);
  });

  test('one slot keeps one key even when the kernel renames its device node', () => {
    // ttyUSBn is handed out in enumeration order and shuffles on replug, so
    // keying the throttle on the path would reset it exactly when flapping.
    assert.equal(
      alerts.attachFailed('/dev/ttyUSB2', '1-6.3.4.1', 'e', null).key,
      alerts.attachFailed('/dev/ttyUSB7', '1-6.3.4.1', 'e', null).key,
    );
  });
});

describe('alerts — escaping', () => {
  test('labels, paths and error text are escaped for HTML parse mode', () => {
    const { text } = alerts.attached('O2 & <Data>', '/dev/tty<USB>2', null);
    assert.match(text, /O2 &amp; &lt;Data&gt;/);
    assert.doesNotMatch(text, /<Data>/);

    const failed = alerts.attachFailed('/dev/ttyUSB2', '1-6.3.4.1', 'broke <badly> & "loudly"', null);
    assert.doesNotMatch(failed.text, /<badly>/);
    assert.match(failed.text, /&quot;loudly&quot;/);
  });
});

describe('alerts — reconnection', () => {
  test('a modem coming back reports how long it was gone', () => {
    assert.match(alerts.attached('A', '/dev/ttyUSB2', 47_000).text, /back after 47s/);
    assert.match(alerts.attached('A', '/dev/ttyUSB2', 3_930_000).text, /back after 1h 5m/);
    assert.match(alerts.attached('A', '/dev/ttyUSB2', null).text, /connected/);
  });
});
