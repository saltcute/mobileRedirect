import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Uses the built-in `node:sqlite` rather than better-sqlite3 deliberately: it
 * removes the last native dependency that would need compiling on ARM, which
 * matters because production is a Raspberry Pi.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS modems (
      id            INTEGER PRIMARY KEY,
      imei          TEXT NOT NULL UNIQUE,
      iccid         TEXT,
      label         TEXT NOT NULL,
      own_number    TEXT,
      usb_location  TEXT,
      last_seen     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY,
      modem_id      INTEGER NOT NULL REFERENCES modems(id) ON DELETE CASCADE,
      direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
      peer_number   TEXT NOT NULL,
      text          TEXT NOT NULL,
      encoding      TEXT,
      parts         INTEGER NOT NULL DEFAULT 1,
      sms_timestamp TEXT,
      created_at    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'ok',
      mr            INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_modem_time
      ON messages(modem_id, created_at DESC);

    -- Inbound SMS are persisted BEFORE being deleted from the SIM, so a crash
    -- between the two steps replays the message. This constraint absorbs that
    -- replay. SCTS has one-second granularity, so a genuine duplicate from a
    -- human sender within the same second is not a realistic scenario.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe
      ON messages(modem_id, direction, peer_number, sms_timestamp, text)
      WHERE direction = 'in' AND sms_timestamp IS NOT NULL;

    CREATE TABLE IF NOT EXISTS concat_buffer (
      id          INTEGER PRIMARY KEY,
      modem_id    INTEGER NOT NULL REFERENCES modems(id) ON DELETE CASCADE,
      sender      TEXT NOT NULL,
      reference   INTEGER NOT NULL,
      total       INTEGER NOT NULL,
      sequence    INTEGER NOT NULL,
      text        TEXT NOT NULL,
      sms_timestamp TEXT,
      created_at  INTEGER NOT NULL,
      UNIQUE (modem_id, sender, reference, sequence)
    );

    CREATE TABLE IF NOT EXISTS chat_state (
      chat_id           INTEGER PRIMARY KEY,
      selected_modem_id INTEGER REFERENCES modems(id) ON DELETE SET NULL
    );

    -- Maps a Telegram message the bot posted back to the SMS it represents, so a
    -- native swipe-reply can be routed to the right peer on the right modem.
    CREATE TABLE IF NOT EXISTS tg_map (
      chat_id       INTEGER NOT NULL,
      tg_message_id INTEGER NOT NULL,
      message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, tg_message_id)
    );
  `);
}
