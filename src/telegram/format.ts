import type { ModemStatus } from '../modem/modem.js';
import type { MessageRow } from '../store/repo.js';
import type { IncomingSms } from '../modem/sms-rx.js';

/** Telegram HTML parse mode needs these five escaped; anything else is literal. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function signalBars(bars: number): string {
  return '▂▄▆█'.slice(0, Math.max(0, Math.min(4, bars))) || '·';
}

function formatTime(value: string | number | null): string {
  if (value === null) return 'unknown time';
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
}

/** An inbound SMS as posted to Telegram. Reply to this message to answer it. */
export function formatIncomingSms(sms: IncomingSms, modemLabel: string): string {
  const parts = sms.parts > 1 ? ` · ${sms.parts} parts` : '';
  return [
    `📩 <code>${escapeHtml(sms.from)}</code> → <b>${escapeHtml(modemLabel)}</b>`,
    `<i>${escapeHtml(formatTime(sms.timestamp))}${parts}</i>`,
    '',
    escapeHtml(sms.text),
  ].join('\n');
}

export function formatStatus(status: ModemStatus): string {
  const lines: string[] = [`<b>${escapeHtml(status.label)}</b>`];

  const sig = status.signal;
  if (sig) {
    const strength =
      sig.dbm === null
        ? 'unknown'
        : `${sig.dbm} dBm ${signalBars(sig.bars)} (${sig.bars}/5)`;
    lines.push(`  Signal: ${escapeHtml(strength)}`);
  } else {
    lines.push('  Signal: unavailable');
  }

  if (status.operator) {
    const tech = status.operator.accessTechnology
      ? ` · ${status.operator.accessTechnology}`
      : '';
    lines.push(`  Carrier: ${escapeHtml((status.operator.name ?? 'unknown') + tech)}`);
  }

  if (status.registration) {
    const roaming = status.registration.roaming ? ' 🌍 roaming' : '';
    lines.push(`  Network: ${escapeHtml(status.registration.description)}${roaming}`);
  }
  if (status.operator?.selectionMode === 1) {
    // A hard lock never retries elsewhere, so it must be visible at a glance.
    const stuck = status.registration?.registered === false ? ' — and not registered' : '';
    lines.push(`  ⚠️ Carrier locked manually${escapeHtml(stuck)} (/network auto to release)`);
  }
  if (status.gprsRegistration) {
    lines.push(`  Data: ${escapeHtml(status.gprsRegistration.description)}`);
  }
  if (status.simState) lines.push(`  SIM: ${escapeHtml(status.simState)}`);
  if (status.ownNumber) lines.push(`  Number: <code>${escapeHtml(status.ownNumber)}</code>`);

  if (status.storage) {
    const { used, total } = status.storage;
    const warn = total > 0 && used / total > 0.8 ? ' ⚠️' : '';
    lines.push(`  SMS storage: ${used}/${total}${warn}`);
  }

  if (status.systemInfo) lines.push(`  <code>${escapeHtml(status.systemInfo)}</code>`);

  lines.push(
    `  <i>IMEI ${escapeHtml(status.imei)} · ${escapeHtml(status.devicePath)} @ ${escapeHtml(status.usbLocation)}</i>`,
  );

  return lines.join('\n');
}

export function formatHistory(
  messages: MessageRow[],
  labelFor: (modemId: number) => string,
): string {
  if (messages.length === 0) return 'No messages recorded yet.';

  // Oldest first reads like a conversation.
  return messages
    .slice()
    .reverse()
    .map((m) => {
      const arrow = m.direction === 'in' ? '←' : '→';
      const when = formatTime(m.direction === 'in' ? m.sms_timestamp : m.created_at);
      const flag = m.status === 'failed' ? ' ❌' : '';
      return [
        `${arrow} <code>${escapeHtml(m.peer_number)}</code> · <i>${escapeHtml(when)}</i>${flag}`,
        `   ${escapeHtml(m.text)}`,
      ].join('\n');
    })
    .join('\n\n');
}
