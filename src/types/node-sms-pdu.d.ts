declare module 'node-sms-pdu' {
  export interface SubmitPart {
    /** Buffer object of the PDU */
    buffer: Buffer;
    /** HEX string of the PDU (what gets written after the `>` prompt) */
    hex: string;
    /** Byte length WITHOUT the SCA — this is the value `AT+CMGS=<n>` expects */
    length: number;
    encoding: 'gsm' | 'ucs2';
  }

  export interface ConcatInfo {
    reference: number;
    total: number;
    sequence: number;
  }

  export interface ParsedDeliver {
    smsc: string | null;
    type: 'SMS-DELIVER';
    origination: string | null;
    /** ISO 8601 string */
    timestamp: string | null;
    concat: ConcatInfo | null;
    text: string | null;
    details: unknown;
    error?: undefined;
  }

  export interface ParsedSubmit {
    smsc: string | null;
    type: 'SMS-SUBMIT';
    reference: number;
    destination: string | null;
    period: string | null;
    concat: ConcatInfo | null;
    text: string | null;
    details: unknown;
    error?: undefined;
  }

  export interface ParseError {
    error: Error;
  }

  export type ParseResult = ParsedDeliver | ParsedSubmit | ParseError;

  /** Throws on invalid number/text. Returns one entry per SMS part. */
  export function generateSubmit(
    number: string,
    text: string,
    options?: { encoding?: 'gsm' | 'ucs2' },
  ): SubmitPart[];

  /** Never throws — returns `{ error }` on failure. */
  export function parse(data: string | Buffer): ParseResult;

  export function getEncoding(text: string): 'gsm' | 'ucs2';
}
