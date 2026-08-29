/** Parsers for AT response payloads. Pure functions — unit-testable without hardware. */

/** `AT+CSQ` -> `+CSQ: <rssi>,<ber>`. 0..31 maps linearly; 99 means "unknown". */
export function csqToDbm(rssi: number): number | null {
  if (rssi === 99 || rssi < 0 || rssi > 31) return null;
  return -113 + 2 * rssi;
}

/** Five-step bar rating from raw CSQ, for display. */
export function csqToBars(rssi: number): number {
  if (rssi === 99 || rssi < 0 || rssi > 31) return 0;
  if (rssi >= 20) return 5;
  if (rssi >= 15) return 4;
  if (rssi >= 10) return 3;
  if (rssi >= 5) return 2;
  return 1;
}

export interface SignalInfo {
  rssi: number;
  dbm: number | null;
  bars: number;
  ber: number | null;
}

export function parseCsq(lines: string[]): SignalInfo | null {
  for (const line of lines) {
    const m = /^\+CSQ:\s*(\d+),\s*(\d+)/.exec(line);
    if (!m) continue;
    const rssi = Number(m[1]);
    const ber = Number(m[2]);
    return {
      rssi,
      dbm: csqToDbm(rssi),
      bars: csqToBars(rssi),
      ber: ber === 99 ? null : ber,
    };
  }
  return null;
}

/** +COPS access technology codes relevant to the SIM7070 (Cat-M / NB-IoT / GPRS). */
const ACCESS_TECH: Record<number, string> = {
  0: 'GSM',
  1: 'GSM Compact',
  2: 'UTRAN',
  3: 'GSM/EGPRS',
  4: 'UTRAN/HSDPA',
  5: 'UTRAN/HSUPA',
  6: 'UTRAN/HSPA',
  7: 'LTE-M',
  8: 'EC-GSM-IoT',
  9: 'NB-IoT',
};

export interface OperatorInfo {
  name: string | null;
  accessTechnology: string | null;
}

/** `AT+COPS?` -> `+COPS: <mode>[,<format>,<oper>[,<AcT>]]` */
export function parseCops(lines: string[]): OperatorInfo | null {
  for (const line of lines) {
    const m = /^\+COPS:\s*(\d+)(?:,\s*(\d+),\s*"?([^",]*)"?(?:,\s*(\d+))?)?/.exec(line);
    if (!m) continue;
    const act = m[4] === undefined ? null : (ACCESS_TECH[Number(m[4])] ?? `AcT ${m[4]}`);
    return { name: m[3]?.trim() || null, accessTechnology: act };
  }
  return null;
}

const REGISTRATION_STATE: Record<number, string> = {
  0: 'not registered',
  1: 'registered (home)',
  2: 'searching',
  3: 'registration denied',
  4: 'unknown',
  5: 'registered (roaming)',
};

export interface RegistrationInfo {
  stat: number;
  description: string;
  roaming: boolean;
  registered: boolean;
}

/**
 * `AT+CREG?` / `AT+CGREG?` -> `+CREG: <n>,<stat>[,...]`
 *
 * The query form leads with <n>, so <stat> is the *second* field. (The URC form
 * omits <n> — we never enable it, so this only handles the query shape.)
 */
export function parseCreg(lines: string[], prefix = 'CREG'): RegistrationInfo | null {
  const re = new RegExp(`^\\+${prefix}:\\s*(\\d+),\\s*(\\d+)`);
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const stat = Number(m[2]);
    return {
      stat,
      description: REGISTRATION_STATE[stat] ?? `state ${stat}`,
      roaming: stat === 5,
      registered: stat === 1 || stat === 5,
    };
  }
  return null;
}

export interface StorageInfo {
  used: number;
  total: number;
}

/** `AT+CPMS?` -> `+CPMS: "SM",<used>,<total>,...` */
export function parseCpms(lines: string[]): StorageInfo | null {
  for (const line of lines) {
    const m = /^\+CPMS:\s*"[^"]*",\s*(\d+),\s*(\d+)/.exec(line);
    if (!m) continue;
    return { used: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}

/** `AT+CPSI?` -> `+CPSI: <system mode>,<operation mode>,...` */
export function parseCpsi(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^\+CPSI:\s*(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** `AT+CPIN?` -> `+CPIN: READY` */
export function parseCpin(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^\+CPIN:\s*(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * `AT+CNUM` -> `+CNUM: "<alpha>","<number>",<type>`. Often absent — many SIMs
 * never have the MSISDN written to them.
 *
 * <type> is a GSM 04.08 type-of-number octet: 145 (0x91) means the number is
 * international but written without its leading `+`, which is how the SIM7070
 * reports it. Ignoring the field yields a number that looks national and cannot
 * be dialled back.
 */
export function parseCnum(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^\+CNUM:\s*(?:"[^"]*")?,\s*"([^"]+)"(?:,\s*(\d+))?/.exec(line);
    if (!m?.[1]) continue;
    const number = m[1].trim();
    const type = m[2] === undefined ? null : Number(m[2]);
    if (type === 145 && !number.startsWith('+')) return `+${number}`;
    return number;
  }
  return null;
}

/**
 * `AT+CCID` / `AT+CICCID` -> `+CCID: <digits>`; some firmware answers with bare
 * digits, and which spelling is accepted varies by revision (1951B16SIM7070
 * rejects `AT+CICCID` outright).
 *
 * The value is BCD-encoded, so an odd-length ICCID arrives with a trailing `F`
 * nibble pad (`...119f`). That pad is stripped — leaving it in corrupts the key
 * used for MODEM_LABELS lookups and SIM identity.
 */
export function parseIccid(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^\+(?:I?CCID):\s*([0-9A-Fa-f]+)/.exec(line);
    const raw = m?.[1] ?? (/^[0-9A-Fa-f]{18,22}$/.test(line.trim()) ? line.trim() : null);
    if (!raw) continue;
    const digits = raw.replace(/[fF]+$/, '');
    if (/^\d{18,20}$/.test(digits)) return digits;
  }
  return null;
}

/** `AT+CGSN` answers with a bare 15-digit IMEI on its own line. */
export function parseImei(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^(\d{14,17})$/.exec(line.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

/** `AT+CMGS=...` -> `+CMGS: <mr>` */
export function parseCmgsReference(lines: string[]): number | null {
  for (const line of lines) {
    const m = /^\+CMGS:\s*(\d+)/.exec(line);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

export interface StoredPdu {
  index: number;
  status: number;
  pduHex: string;
}

/**
 * `AT+CMGL=4` in PDU mode returns pairs of lines:
 *   +CMGL: <index>,<stat>,[<alpha>],<length>
 *   <pdu hex>
 */
export function parseCmgl(lines: string[]): StoredPdu[] {
  const out: StoredPdu[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\+CMGL:\s*(\d+),\s*(\d+)/.exec(lines[i] ?? '');
    if (!m) continue;
    const pdu = lines[i + 1]?.trim();
    if (pdu && /^[0-9A-Fa-f]+$/.test(pdu)) {
      out.push({ index: Number(m[1]), status: Number(m[2]), pduHex: pdu });
      i++;
    }
  }
  return out;
}

/**
 * `AT+CMGR=<i>` in PDU mode:
 *   +CMGR: <stat>,[<alpha>],<length>
 *   <pdu hex>
 */
export function parseCmgr(lines: string[]): { status: number; pduHex: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = /^\+CMGR:\s*(\d+)/.exec(lines[i] ?? '');
    if (!m) continue;
    const pdu = lines[i + 1]?.trim();
    if (pdu && /^[0-9A-Fa-f]+$/.test(pdu)) {
      return { status: Number(m[1]), pduHex: pdu };
    }
  }
  return null;
}

/** URC `+CMTI: "SM",<index>` -> storage + index of the newly stored message. */
export function parseCmti(line: string): { storage: string; index: number } | null {
  const m = /^\+CMTI:\s*"([^"]*)",\s*(\d+)/.exec(line);
  if (!m) return null;
  return { storage: m[1] ?? 'SM', index: Number(m[2]) };
}

/**
 * Normalise to E.164-ish form for consistent keying/display.
 * Leaves national numbers alone — we can't invent a country code.
 */
export function normaliseNumber(raw: string): string {
  const trimmed = raw.trim().replace(/[\s\-()]/g, '');
  if (/^00\d+$/.test(trimmed)) return `+${trimmed.slice(2)}`;
  return trimmed;
}

/** Accepts +<digits> or bare national digits; rejects anything node-sms-pdu would throw on. */
export function isValidDestination(raw: string): boolean {
  const n = raw.trim().replace(/[\s\-()]/g, '');
  return /^\+?\d{3,20}$/.test(n);
}
