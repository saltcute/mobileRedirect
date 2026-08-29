/** Builds SMS-DELIVER PDUs for tests. UCS-2 so payloads need no 7-bit packing. */

const hex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase();

function encodeAddress(number: string): string {
  const international = number.startsWith('+');
  const digits = number.replace(/^\+/, '');
  const padded = digits.length % 2 ? `${digits}F` : digits;
  let swapped = '';
  for (let i = 0; i < padded.length; i += 2) swapped += `${padded[i + 1]}${padded[i]}`;
  return hex(digits.length) + hex(international ? 0x91 : 0x81) + swapped.toUpperCase();
}

function encodeScts(date: Date): string {
  const pair = (v: number): string => {
    const s = String(v).padStart(2, '0');
    return `${s[1]}${s[0]}`;
  };
  return (
    pair(date.getUTCFullYear() % 100) +
    pair(date.getUTCMonth() + 1) +
    pair(date.getUTCDate()) +
    pair(date.getUTCHours()) +
    pair(date.getUTCMinutes()) +
    pair(date.getUTCSeconds()) +
    '00'
  );
}

export interface DeliverOptions {
  from: string;
  text: string;
  concat?: { reference: number; total: number; sequence: number };
  date?: Date;
}

export function buildDeliverPdu(opts: DeliverOptions): string {
  const date = opts.date ?? new Date(Date.UTC(2024, 0, 15, 12, 30, 45));
  const payload = Buffer.from(opts.text, 'utf16le').swap16().toString('hex').toUpperCase();

  let pdu = '00'; // no SMSC in the PDU
  pdu += opts.concat ? '44' : '04'; // UDHI set when concatenated
  pdu += encodeAddress(opts.from);
  pdu += '00'; // PID
  pdu += '08'; // DCS: UCS-2
  pdu += encodeScts(date);

  if (opts.concat) {
    const { reference, total, sequence } = opts.concat;
    const udh = `050003${hex(reference)}${hex(total)}${hex(sequence)}`;
    pdu += hex((udh.length + payload.length) / 2) + udh + payload;
  } else {
    pdu += hex(payload.length / 2) + payload;
  }
  return pdu;
}
