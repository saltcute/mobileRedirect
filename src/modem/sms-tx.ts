import smsPdu from 'node-sms-pdu';
import type { AtChannel } from './at-channel.js';
import { parseCmgsReference } from './parse.js';
import type { Logger } from '../logger.js';

export interface SendResult {
  parts: number;
  encoding: 'gsm' | 'ucs2';
  /** Network message reference per part; `null` where the modem didn't report one. */
  references: (number | null)[];
}

/**
 * Send an SMS in PDU mode, segmenting automatically.
 *
 * PDU mode (not text mode) is used throughout: text mode cannot represent
 * non-GSM-7 characters and offers no way to build the UDH that concatenated
 * messages require.
 */
export async function sendSms(
  channel: AtChannel,
  log: Logger,
  destination: string,
  text: string,
): Promise<SendResult> {
  const parts = smsPdu.generateSubmit(destination, text);
  if (parts.length === 0) throw new Error('message produced no PDU parts');

  const encoding = parts[0]!.encoding;
  const references: (number | null)[] = [];

  log.info(
    { destination, parts: parts.length, encoding },
    'sending sms',
  );

  for (const [i, part] of parts.entries()) {
    // `part.length` is the TPDU byte count excluding the SCA, which is exactly
    // what AT+CMGS expects — do not use part.hex.length / 2 here.
    const lines = await channel.submitPdu(part.length, part.hex);
    const mr = parseCmgsReference(lines);
    references.push(mr);
    log.debug({ part: i + 1, of: parts.length, mr }, 'sms part accepted');
  }

  return { parts: parts.length, encoding, references };
}

/** Segment/encoding preview without touching the modem — used to confirm before sending. */
export function previewMessage(
  destination: string,
  text: string,
): { parts: number; encoding: 'gsm' | 'ucs2' } {
  const parts = smsPdu.generateSubmit(destination, text);
  return { parts: parts.length, encoding: parts[0]?.encoding ?? 'gsm' };
}
