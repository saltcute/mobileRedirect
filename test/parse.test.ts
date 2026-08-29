import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  csqToDbm,
  csqToBars,
  parseCsq,
  parseCops,
  parseCreg,
  parseCpms,
  parseCmgl,
  parseCmgr,
  parseCmti,
  parseCmgsReference,
  parseImei,
  parseIccid,
  parseCnum,
  normaliseNumber,
  isValidDestination,
} from '../src/modem/parse.ts';
import { diagnoseOpenError } from '../src/modem/open-errors.ts';

describe('signal strength', () => {
  test('maps CSQ across its linear range', () => {
    assert.equal(csqToDbm(0), -113);
    assert.equal(csqToDbm(31), -51);
    assert.equal(csqToDbm(16), -81);
  });

  test('treats 99 and out-of-range values as unknown', () => {
    assert.equal(csqToDbm(99), null);
    assert.equal(csqToDbm(32), null);
    assert.equal(csqToDbm(-1), null);
    assert.equal(csqToBars(99), 0);
  });

  test('parses +CSQ, folding ber 99 to null', () => {
    assert.deepEqual(parseCsq(['+CSQ: 22,0']), {
      rssi: 22,
      dbm: -69,
      bars: 5,
      ber: 0,
    });
    assert.equal(parseCsq(['+CSQ: 99,99'])?.dbm, null);
    assert.equal(parseCsq(['+CSQ: 99,99'])?.ber, null);
    assert.equal(parseCsq(['nothing here']), null);
  });
});

describe('+COPS', () => {
  test('reads operator name and access technology', () => {
    assert.deepEqual(parseCops(['+COPS: 0,0,"Vodafone.de",9']), {
      name: 'Vodafone.de',
      accessTechnology: 'NB-IoT',
    });
    assert.equal(parseCops(['+COPS: 0,0,"T-Mobile",7'])?.accessTechnology, 'LTE-M');
  });

  test('handles the deregistered short form', () => {
    assert.deepEqual(parseCops(['+COPS: 0']), { name: null, accessTechnology: null });
  });
});

describe('+CREG', () => {
  test('takes stat from the second field of the query form', () => {
    const home = parseCreg(['+CREG: 0,1']);
    assert.equal(home?.stat, 1);
    assert.equal(home?.registered, true);
    assert.equal(home?.roaming, false);
  });

  test('flags roaming on stat 5', () => {
    const roaming = parseCreg(['+CREG: 2,5,"1A2B","03D4"']);
    assert.equal(roaming?.roaming, true);
    assert.equal(roaming?.registered, true);
  });

  test('reads the CGREG variant', () => {
    assert.equal(parseCreg(['+CGREG: 0,2'], 'CGREG')?.description, 'searching');
  });
});

describe('storage and identity', () => {
  test('parses +CPMS occupancy', () => {
    assert.deepEqual(parseCpms(['+CPMS: "SM",3,30,"SM",3,30,"SM",3,30']), {
      used: 3,
      total: 30,
    });
  });

  test('parses a bare IMEI line', () => {
    assert.equal(parseImei(['867584031234567']), '867584031234567');
    assert.equal(parseImei(['OK']), null);
  });

  test('accepts both ICCID spellings and the bare form', () => {
    assert.equal(parseIccid(['+ICCID: 8949012345678901234']), '8949012345678901234');
    assert.equal(parseIccid(['+CCID: 8949012345678901234']), '8949012345678901234');
    assert.equal(parseIccid(['8949012345678901234']), '8949012345678901234');
  });

  test('strips the BCD F pad from an odd-length ICCID', () => {
    // Real response from firmware 1951B16SIM7070: 19 digits + one nibble pad.
    assert.equal(parseIccid(['+CCID: 8914900010144783119f']), '8914900010144783119');
    assert.equal(parseIccid(['+CCID: 8914900010144783119F']), '8914900010144783119');
  });

  test('rejects a value that is not a plausible ICCID', () => {
    assert.equal(parseIccid(['+CCID: ERROR']), null);
    assert.equal(parseIccid(['+CCID: 1234']), null);
  });

  test('parses +CNUM when the SIM has an MSISDN', () => {
    assert.equal(parseCnum(['+CNUM: "","+4915112345678",145']), '+4915112345678');
    assert.equal(parseCnum([]), null);
  });

  test('restores the + on a type-145 international number', () => {
    // Real SIM7070 response: international, but written without the leading +.
    assert.equal(parseCnum(['+CNUM: "","16479060432",145']), '+16479060432');
  });

  test('leaves a national number (type 129) alone', () => {
    assert.equal(parseCnum(['+CNUM: "","016479060432",129']), '016479060432');
  });
});

describe('SMS storage listings', () => {
  test('pairs each +CMGL header with the PDU line that follows', () => {
    const listed = parseCmgl([
      '+CMGL: 1,0,,25',
      '07914400000000F0040B914477665544332211',
      '+CMGL: 3,0,,20',
      '07914400000000F0040B914477665544332299',
    ]);
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.index, 1);
    assert.equal(listed[1]?.index, 3);
    assert.equal(listed[1]?.pduHex, '07914400000000F0040B914477665544332299');
  });

  test('skips a header whose PDU line is missing', () => {
    assert.deepEqual(parseCmgl(['+CMGL: 1,0,,25']), []);
  });

  test('parses a single +CMGR read', () => {
    const read = parseCmgr(['+CMGR: 0,,25', '07914400000000F0040B91447766554433']);
    assert.equal(read?.status, 0);
    assert.equal(read?.pduHex, '07914400000000F0040B91447766554433');
  });

  test('parses the +CMTI new-message indication', () => {
    assert.deepEqual(parseCmti('+CMTI: "SM",7'), { storage: 'SM', index: 7 });
    assert.equal(parseCmti('+CSQ: 20,0'), null);
  });

  test('extracts the +CMGS message reference', () => {
    assert.equal(parseCmgsReference(['+CMGS: 42']), 42);
    assert.equal(parseCmgsReference(['OK']), null);
  });
});

describe('number handling', () => {
  test('converts 00 international prefix to +', () => {
    assert.equal(normaliseNumber('004915112345678'), '+4915112345678');
  });

  test('strips separators but leaves national numbers alone', () => {
    assert.equal(normaliseNumber('+49 151 (123) 456-78'), '+4915112345678');
    assert.equal(normaliseNumber('0151234567'), '0151234567');
  });

  test('validates destinations', () => {
    assert.equal(isValidDestination('+4915112345678'), true);
    assert.equal(isValidDestination('0151 234 567'), true);
    assert.equal(isValidDestination('not-a-number'), false);
    assert.equal(isValidDestination('+49abc'), false);
    assert.equal(isValidDestination('12'), false);
  });
});

describe('open error diagnosis', () => {
  test('recognises a permissions failure', () => {
    const hint = diagnoseOpenError('Error: Permission denied, cannot open /dev/ttyUSB2');
    assert.match(hint ?? '', /99-sim7070\.rules/);
  });

  test('recognises a port already claimed by another process', () => {
    // The exact string serialport surfaces on the Pi when ModemManager holds it.
    const hint = diagnoseOpenError('Error: Device or resource busy, cannot open /dev/ttyUSB8');
    assert.match(hint ?? '', /ModemManager/);
  });

  test('stays quiet on an unrecognised failure', () => {
    assert.equal(diagnoseOpenError('Error: No such file or directory'), null);
  });
});
