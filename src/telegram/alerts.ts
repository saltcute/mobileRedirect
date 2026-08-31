/**
 * Every operational event, as the message the operator actually reads.
 *
 * Pure: each takes plain data and returns a `Notification`, so the whole
 * catalogue — wording, severity and throttle key — is testable without a bot or
 * a modem, and `main.ts` stays a wiring file.
 */

import { escapeHtml } from './format.js';
import type { Notification } from './notify.js';
import type { DetachReason } from '../modem/registry.js';
import type { SimStatus } from '../modem/health-state.js';

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function started(
  modems: { label: string; devicePath: string }[],
  emptyReason: string | null,
): Notification {
  const lines = ['🟢 <b>Gateway started</b>'];
  if (modems.length > 0) {
    lines.push('');
    for (const m of modems) {
      lines.push(`  • <b>${escapeHtml(m.label)}</b> — <code>${escapeHtml(m.devicePath)}</code>`);
    }
    return { level: 'normal', text: lines.join('\n') };
  }
  // Prefer the scan's own explanation over a bare "none attached" — it names the
  // actual cause (no module, no AT port bound, sysfs unreadable).
  lines.push('', `⚠️ No modems attached — ${escapeHtml(emptyReason ?? 'reason unknown')}`);
  // Critical rather than normal: booting to nothing is the failure itself, and
  // folding it into an ordinary start-up notice would hide it at `critical`,
  // which is exactly the level someone picks to hear only about breakage.
  return { level: 'critical', text: lines.join('\n') };
}

export function stopped(signal: string): Notification {
  return {
    level: 'normal',
    text: `🔴 <b>Gateway stopped</b> — received <code>${escapeHtml(signal)}</code>`,
  };
}

export function attached(label: string, devicePath: string, downMs: number | null): Notification {
  if (downMs !== null) {
    return {
      level: 'normal',
      text:
        `✅ <b>${escapeHtml(label)}</b> is back after ${escapeHtml(duration(downMs))} — ` +
        `<code>${escapeHtml(devicePath)}</code>`,
    };
  }
  return {
    level: 'normal',
    text: `🔌 <b>${escapeHtml(label)}</b> connected — <code>${escapeHtml(devicePath)}</code>`,
  };
}

export function detached(label: string, reason: DetachReason): Notification {
  switch (reason) {
    case 'vanished':
      return {
        level: 'critical',
        text:
          `🚨 <b>${escapeHtml(label)}</b> disappeared from the USB bus — it reset or ` +
          'browned out. A SIM7070 draws ~2A peaks while transmitting; if this repeats ' +
          'during sends or network operations, suspect the power supply before the firmware.',
      };
    case 'channel-lost':
      return {
        level: 'critical',
        text:
          `🚨 <b>${escapeHtml(label)}</b> stopped responding mid-command and its port ` +
          'was released. It should re-attach on its own once it re-enumerates.',
      };
    case 'port-closed':
      return {
        level: 'verbose',
        text: `⚪ <b>${escapeHtml(label)}</b> disconnected — its port closed.`,
      };
  }
}

export function attachFailed(
  devicePath: string,
  usbLocation: string,
  message: string,
  hint: string | null,
): Notification {
  return {
    // Keyed on the USB slot, not the device node: `ttyUSBn` is handed out in
    // enumeration order and shuffles on replug, so a path-keyed throttle would
    // reset itself exactly when a port is flapping.
    key: `attach-failed:${usbLocation}`,
    level: 'critical',
    text: hint
      ? `🚨 <b>Cannot open <code>${escapeHtml(devicePath)}</code></b>\n${escapeHtml(hint)}`
      : `🚨 <b>Cannot attach <code>${escapeHtml(devicePath)}</code></b>\n${escapeHtml(message)}`,
  };
}

export function scanEmpty(reason: string): Notification {
  return {
    key: 'scan-empty',
    level: 'critical',
    text: `🚨 <b>No modems found</b>\n${escapeHtml(reason)}`,
  };
}

export function pollFailing(label: string, consecutive: number, message: string): Notification {
  return {
    key: `poll-failing:${label}`,
    level: 'critical',
    text:
      `🚨 <b>${escapeHtml(label)}</b> is attached but not answering — ` +
      `${consecutive} polls in a row failed.\n<code>${escapeHtml(message)}</code>`,
  };
}

export function pollRecovered(label: string): Notification {
  return {
    level: 'verbose',
    text: `✅ <b>${escapeHtml(label)}</b> is answering again.`,
  };
}

export function simChanged(
  label: string,
  from: SimStatus | null,
  to: SimStatus,
): Notification {
  const modem = `<b>${escapeHtml(label)}</b>`;
  if (to.kind === 'absent') {
    return { level: 'critical', text: `🚨 ${modem} — <b>SIM removed</b>` };
  }
  if (to.kind === 'locked') {
    const puk = /PUK/i.test(to.detail)
      ? '\n⚠️ Entering the wrong PIN repeatedly is what leads here, and a wrong PUK ' +
        'permanently kills the SIM. Unlock it in a phone rather than guessing.'
      : '';
    return {
      level: 'critical',
      text: `🚨 ${modem} — SIM is locked: <code>${escapeHtml(to.detail)}</code>${puk}`,
    };
  }
  // Ready. Whether this reads as "installed" or "unlocked" depends on where it
  // came from; from nothing at all it is the first reading after attach.
  const verb = from?.kind === 'absent' || from === null ? 'SIM installed' : 'SIM ready';
  return { level: 'normal', text: `💳 ${modem} — <b>${verb}</b>` };
}

export function signalLow(label: string, bars: number): Notification {
  return {
    level: 'normal',
    text: `📶 <b>${escapeHtml(label)}</b> — signal is weak (${bars}/5) and has stayed there.`,
  };
}

export function signalRecovered(label: string, bars: number): Notification {
  return {
    level: 'verbose',
    text: `📶 <b>${escapeHtml(label)}</b> — signal recovered (${bars}/5).`,
  };
}

export function hardwareCondition(label: string, urc: string): Notification {
  return {
    key: `hardware:${label}:${urc}`,
    level: 'critical',
    text:
      `🚨 <b>${escapeHtml(label)}</b> reported <code>${escapeHtml(urc)}</code>.\n` +
      'This is the module itself naming a power problem — check the supply and any ' +
      'powered hub before looking at the firmware.',
  };
}

export function unauthorised(
  userId: number | undefined,
  username: string | undefined,
  chatId: number | undefined,
): Notification {
  const who = username ? `@${username}` : 'no username';
  return {
    key: `unauthorised:${userId ?? 'unknown'}`,
    level: 'critical',
    text:
      '🚨 <b>Unauthorised access attempt</b>\n' +
      `User <code>${escapeHtml(String(userId ?? 'unknown'))}</code> (${escapeHtml(who)}) ` +
      `in chat <code>${escapeHtml(String(chatId ?? 'unknown'))}</code> was refused.\n` +
      'Add them to <code>ALLOWED_USER_IDS</code> if this was you.',
  };
}
