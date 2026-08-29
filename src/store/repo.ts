import type { DatabaseSync } from 'node:sqlite';

export interface ModemRow {
  id: number;
  imei: string;
  iccid: string | null;
  label: string;
  own_number: string | null;
  usb_location: string | null;
  last_seen: number;
}

export interface MessageRow {
  id: number;
  modem_id: number;
  direction: 'in' | 'out';
  peer_number: string;
  text: string;
  encoding: string | null;
  parts: number;
  sms_timestamp: string | null;
  created_at: number;
  status: string;
  mr: number | null;
}

export interface InboundMessage {
  modemId: number;
  peerNumber: string;
  text: string;
  smsTimestamp: string | null;
  parts?: number;
}

export interface OutboundMessage {
  modemId: number;
  peerNumber: string;
  text: string;
  encoding: string;
  parts: number;
  mr: number | null;
  status?: string;
}

const asNumber = (v: unknown): number =>
  typeof v === 'bigint' ? Number(v) : (v as number);

/** node:sqlite hands back Record<string, SQLOutputValue>; these assert our column shape. */
const row = <T>(v: unknown): T | null => (v as T | undefined) ?? null;
const rows = <T>(v: unknown): T[] => v as T[];

export class Repo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ------------------------------------------------------------------ modems

  /** Insert or refresh a modem keyed on IMEI; returns the row id. */
  upsertModem(input: {
    imei: string;
    iccid: string | null;
    label: string;
    ownNumber: string | null;
    usbLocation: string;
  }): number {
    this.db
      .prepare(
        `INSERT INTO modems (imei, iccid, label, own_number, usb_location, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(imei) DO UPDATE SET
           iccid = excluded.iccid,
           label = excluded.label,
           own_number = excluded.own_number,
           usb_location = excluded.usb_location,
           last_seen = excluded.last_seen`,
      )
      .run(
        input.imei,
        input.iccid,
        input.label,
        input.ownNumber,
        input.usbLocation,
        Date.now(),
      );

    const row = this.db.prepare('SELECT id FROM modems WHERE imei = ?').get(input.imei) as
      | { id: number }
      | undefined;
    if (!row) throw new Error(`failed to upsert modem ${input.imei}`);
    return asNumber(row.id);
  }

  touchModem(modemId: number): void {
    this.db.prepare('UPDATE modems SET last_seen = ? WHERE id = ?').run(Date.now(), modemId);
  }

  getModem(id: number): ModemRow | null {
    return row<ModemRow>(this.db.prepare('SELECT * FROM modems WHERE id = ?').get(id));
  }

  listModems(): ModemRow[] {
    return rows<ModemRow>(this.db.prepare('SELECT * FROM modems ORDER BY label').all());
  }

  // ---------------------------------------------------------------- messages

  /**
   * Records an inbound SMS. Returns the row id, or `null` if the dedupe index
   * rejected it as a replay of a message we already stored.
   */
  insertInbound(msg: InboundMessage): number | null {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (modem_id, direction, peer_number, text, parts, sms_timestamp, created_at, status)
         VALUES (?, 'in', ?, ?, ?, ?, ?, 'received')`,
      )
      .run(
        msg.modemId,
        msg.peerNumber,
        msg.text,
        msg.parts ?? 1,
        msg.smsTimestamp,
        Date.now(),
      );

    if (result.changes === 0) return null;
    return asNumber(result.lastInsertRowid);
  }

  insertOutbound(msg: OutboundMessage): number {
    const result = this.db
      .prepare(
        `INSERT INTO messages
           (modem_id, direction, peer_number, text, encoding, parts, created_at, status, mr)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.modemId,
        msg.peerNumber,
        msg.text,
        msg.encoding,
        msg.parts,
        Date.now(),
        msg.status ?? 'sent',
        msg.mr,
      );
    return asNumber(result.lastInsertRowid);
  }

  getMessage(id: number): MessageRow | null {
    return row<MessageRow>(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  recentMessages(modemId: number | null, limit: number): MessageRow[] {
    if (modemId === null) {
      return rows<MessageRow>(
        this.db
          .prepare('SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(limit),
      );
    }
    return rows<MessageRow>(
      this.db
        .prepare(
          'SELECT * FROM messages WHERE modem_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(modemId, limit),
    );
  }

  // ----------------------------------------------------------- concat buffer

  /** Stores one segment; returns every segment held for that (sender, reference). */
  addConcatPart(part: {
    modemId: number;
    sender: string;
    reference: number;
    total: number;
    sequence: number;
    text: string;
    smsTimestamp: string | null;
  }): { sequence: number; text: string; sms_timestamp: string | null }[] {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO concat_buffer
           (modem_id, sender, reference, total, sequence, text, sms_timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        part.modemId,
        part.sender,
        part.reference,
        part.total,
        part.sequence,
        part.text,
        part.smsTimestamp,
        Date.now(),
      );

    return this.db
      .prepare(
        `SELECT sequence, text, sms_timestamp FROM concat_buffer
         WHERE modem_id = ? AND sender = ? AND reference = ?
         ORDER BY sequence`,
      )
      .all(part.modemId, part.sender, part.reference) as {
      sequence: number;
      text: string;
      sms_timestamp: string | null;
    }[];
  }

  clearConcat(modemId: number, sender: string, reference: number): void {
    this.db
      .prepare(
        'DELETE FROM concat_buffer WHERE modem_id = ? AND sender = ? AND reference = ?',
      )
      .run(modemId, sender, reference);
  }

  /** Groups older than `cutoff` — incomplete multiparts to flush as-is. */
  staleConcatGroups(cutoff: number): {
    modem_id: number;
    sender: string;
    reference: number;
    total: number;
  }[] {
    return this.db
      .prepare(
        `SELECT modem_id, sender, reference, total
         FROM concat_buffer
         GROUP BY modem_id, sender, reference
         HAVING MIN(created_at) < ?`,
      )
      .all(cutoff) as {
      modem_id: number;
      sender: string;
      reference: number;
      total: number;
    }[];
  }

  getConcatParts(
    modemId: number,
    sender: string,
    reference: number,
  ): { sequence: number; text: string; sms_timestamp: string | null }[] {
    return this.db
      .prepare(
        `SELECT sequence, text, sms_timestamp FROM concat_buffer
         WHERE modem_id = ? AND sender = ? AND reference = ?
         ORDER BY sequence`,
      )
      .all(modemId, sender, reference) as {
      sequence: number;
      text: string;
      sms_timestamp: string | null;
    }[];
  }

  // -------------------------------------------------------------- chat state

  getSelectedModem(chatId: number): number | null {
    const row = this.db
      .prepare('SELECT selected_modem_id FROM chat_state WHERE chat_id = ?')
      .get(chatId) as { selected_modem_id: number | null } | undefined;
    return row?.selected_modem_id ?? null;
  }

  setSelectedModem(chatId: number, modemId: number): void {
    this.db
      .prepare(
        `INSERT INTO chat_state (chat_id, selected_modem_id) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET selected_modem_id = excluded.selected_modem_id`,
      )
      .run(chatId, modemId);
  }

  // ----------------------------------------------------- telegram reply map

  mapTelegramMessage(chatId: number, tgMessageId: number, messageId: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_map (chat_id, tg_message_id, message_id) VALUES (?, ?, ?)`,
      )
      .run(chatId, tgMessageId, messageId);
  }

  /** Resolves a swipe-reply target back to the SMS it was posted for. */
  lookupTelegramMessage(chatId: number, tgMessageId: number): MessageRow | null {
    const row = this.db
      .prepare(
        `SELECT m.* FROM tg_map t
         JOIN messages m ON m.id = t.message_id
         WHERE t.chat_id = ? AND t.tg_message_id = ?`,
      )
      .get(chatId, tgMessageId) as MessageRow | undefined;
    return row ?? null;
  }
}
