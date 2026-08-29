import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCops,
  parseCopsScan,
  parseCnmp,
  parseCmnb,
  parseCeer,
} from '../src/modem/parse.ts';

describe('carrier selection state', () => {
  test('reports automatic selection', () => {
    const op = parseCops(['+COPS: 0,0,"Bell",7']);
    assert.equal(op?.selectionMode, 0);
    assert.equal(op?.selectionModeLabel, 'automatic');
    assert.equal(op?.name, 'Bell');
    assert.equal(op?.accessTechnology, 'LTE-M');
  });

  test('distinguishes a hard manual lock from manual-with-fallback', () => {
    // /network use applies mode 1; mode 4 is still parsed because a modem may
    // carry that setting from elsewhere.
    const locked = parseCops(['+COPS: 1,2,"302610",7']);
    assert.equal(locked?.selectionMode, 1);
    assert.equal(locked?.selectionModeLabel, 'manual (locked)');
    assert.equal(
      parseCops(['+COPS: 4,2,"302610",7'])?.selectionModeLabel,
      'manual with automatic fallback',
    );
  });

  test('handles the deregistered short form', () => {
    const op = parseCops(['+COPS: 0']);
    assert.equal(op?.name, null);
    assert.equal(op?.selectionMode, 0);
  });
});

describe('network scan', () => {
  const scan = [
    '+COPS: (2,"Bell","Bell","302610",7),(1,"ROGERS","ROGERS","302720",7),' +
      '(3,"TELUS","TELUS","302220",9),,(0,1,2,3,4),(0,1,2)',
  ];

  test('parses each visible network', () => {
    const found = parseCopsScan(scan);
    assert.equal(found.length, 3, 'trailing capability tuples are not networks');
    assert.deepEqual(
      found.map((o) => o.plmn),
      ['302610', '302720', '302220'],
    );
  });

  test('flags the forbidden network — the carrier-side answer', () => {
    const found = parseCopsScan(scan);
    const telus = found.find((o) => o.plmn === '302220');
    assert.equal(telus?.forbidden, true);
    assert.equal(telus?.statusLabel, 'forbidden');
    assert.equal(telus?.actLabel, 'NB-IoT');

    assert.equal(found.find((o) => o.plmn === '302610')?.forbidden, false);
    assert.equal(found.find((o) => o.plmn === '302610')?.statusLabel, 'current');
    assert.equal(found.find((o) => o.plmn === '302720')?.statusLabel, 'available');
  });

  test('tolerates an entry with no access technology', () => {
    const found = parseCopsScan(['+COPS: (1,"Bell","Bell","302610")']);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.act, null);
    assert.equal(found[0]?.actLabel, null);
  });

  test('returns nothing for an empty scan', () => {
    assert.deepEqual(parseCopsScan(['+COPS: ,,(0,1,2,3,4),(0,1,2)']), []);
  });
});

describe('radio preferences', () => {
  test('parses +CNMP radio generations', () => {
    assert.deepEqual(parseCnmp(['+CNMP: 51']), { value: 51, label: 'GSM + LTE' });
    assert.deepEqual(parseCnmp(['+CNMP: 38']), { value: 38, label: 'LTE only' });
    assert.equal(parseCnmp(['+CNMP: 99'])?.label, 'mode 99');
  });

  test('parses +CMNB LTE-IoT technology', () => {
    // Carriers provision these separately; the wrong one is refused at attach.
    assert.deepEqual(parseCmnb(['+CMNB: 1']), { value: 1, label: 'Cat-M' });
    assert.deepEqual(parseCmnb(['+CMNB: 2']), { value: 2, label: 'NB-IoT' });
    assert.deepEqual(parseCmnb(['+CMNB: 3']), { value: 3, label: 'Cat-M + NB-IoT' });
  });

  test('parses the +CEER reject cause', () => {
    assert.equal(
      parseCeer(['+CEER: EMM cause 11, PLMN not allowed']),
      'EMM cause 11, PLMN not allowed',
    );
    assert.equal(parseCeer(['OK']), null);
  });
});
