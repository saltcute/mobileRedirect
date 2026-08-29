import { InlineKeyboard } from 'grammy';
import type { BotDeps, GatewayBot } from '../deps.js';
import { noModemMessage, resolveModem } from '../deps.js';
import { escapeHtml } from '../format.js';
import type { Modem } from '../../modem/modem.js';
import { LTE_MODE_VALUES, NETWORK_MODE_VALUES } from '../../modem/parse.js';
import { diagnoseChannelLoss } from '../../modem/open-errors.js';

const CALLBACK_PREFIX = 'net:';

const LOCKED_NOTE =
  '<i>Locked — it will not fall back to another carrier, and the lock survives ' +
  'reboots. Use /network auto to release it.</i>';

/**
 * A manual selection that fails leaves the module deregistered rather than on
 * some other network, so say so instead of reporting a bare command error.
 */
function lockFailure(label: string, plmn: string, reason: string): string {
  return (
    `❌ <b>${escapeHtml(label)}</b> could not lock to <code>${escapeHtml(plmn)}</code>: ` +
    `${escapeHtml(reason)}\n\n` +
    '<i>The module is now deregistered — it does not fall back on its own. ' +
    'Use /network auto to restore service, or try another carrier.</i>'
  );
}

/** Friendly names accepted for AT+CMNB. */
const LTE_MODES: Record<string, number> = { catm: 1, nbiot: 2, both: 3 };

/** Friendly names accepted for AT+CNMP. */
const NETWORK_MODES: Record<string, number> = {
  auto: 2,
  gsm: 13,
  lte: 38,
  'gsm+lte': 51,
};

/** Access technologies selectable alongside a carrier. */
const ACCESS_TECHNOLOGIES: Record<string, number> = { gsm: 0, catm: 7, nbiot: 9 };

const USAGE = [
  '<b>/network</b> — current carrier and radio settings',
  '<b>/network scan</b> — list visible carriers (slow, drops registration)',
  '<b>/network auto</b> — automatic carrier selection',
  '<b>/network use &lt;plmn&gt; [gsm|catm|nbiot]</b> — lock to one carrier (no fallback)',
  '<b>/network rat &lt;catm|nbiot|both&gt;</b> — LTE-IoT technology',
  '<b>/network mode &lt;auto|gsm|lte|gsm+lte&gt;</b> — radio generations',
].join('\n');

export function registerNetwork(bot: GatewayBot, deps: BotDeps): void {
  bot.command('network', async (ctx) => {
    const modem = resolveModem(deps, ctx.chat.id);
    if (!modem) {
      await ctx.reply(noModemMessage(deps));
      return;
    }

    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    const [action, ...rest] = args;

    try {
      switch (action) {
        case undefined:
          await showConfig(ctx, modem);
          return;
        case 'scan':
          await runScan(ctx, modem);
          return;
        case 'auto':
          await ctx.reply(`Reverting <b>${escapeHtml(modem.label)}</b> to automatic…`, {
            parse_mode: 'HTML',
          });
          await modem.selectAutomaticNetwork();
          await ctx.reply('✅ Automatic carrier selection restored.');
          return;
        case 'use':
          await useNetwork(ctx, modem, rest);
          return;
        case 'rat':
          await setMode(ctx, modem, rest[0], LTE_MODES, LTE_MODE_VALUES, (v) =>
            modem.setLteMode(v),
          );
          return;
        case 'mode':
          await setMode(ctx, modem, rest[0], NETWORK_MODES, NETWORK_MODE_VALUES, (v) =>
            modem.setNetworkMode(v),
          );
          return;
        default:
          await ctx.reply(`Unknown option <code>${escapeHtml(action)}</code>.\n\n${USAGE}`, {
            parse_mode: 'HTML',
          });
      }
    } catch (err) {
      const message = (err as Error).message;
      deps.logger.error({ modem: modem.label, err: message }, 'network command failed');
      const lost = diagnoseChannelLoss(message);
      await ctx.reply(
        lost
          ? `⚠️ <b>${escapeHtml(modem.label)}</b> — ${escapeHtml(lost)}`
          : `❌ ${escapeHtml(message)}`,
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.callbackQuery(new RegExp(`^${CALLBACK_PREFIX}`), async (ctx) => {
    const [, modemId, plmn, act] = ctx.callbackQuery.data.split(':');
    const modem = deps.registry.byId(Number(modemId));
    if (!modem || !plmn) {
      await ctx.answerCallbackQuery({ text: 'That modem is no longer attached.' });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Locking to ${plmn}…` });
    try {
      await modem.selectNetwork(plmn, act ? Number(act) : undefined);
      await ctx.reply(
        `✅ <b>${escapeHtml(modem.label)}</b> locked to <code>${escapeHtml(plmn)}</code>.\n` +
          LOCKED_NOTE,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      const message = (err as Error).message;
      const lost = diagnoseChannelLoss(message);
      await ctx.reply(
        lost
          ? `⚠️ <b>${escapeHtml(modem.label)}</b> — ${escapeHtml(lost)}`
          : lockFailure(modem.label, plmn, message),
        { parse_mode: 'HTML' },
      );
    }
  });
}

async function showConfig(
  ctx: { reply: (t: string, o?: object) => Promise<unknown> },
  modem: Modem,
): Promise<void> {
  const cfg = await modem.networkConfig();
  const lines = [`<b>${escapeHtml(modem.label)}</b>`];

  const carrier = cfg.operator?.name ?? 'none';
  const tech = cfg.operator?.accessTechnology ? ` · ${cfg.operator.accessTechnology}` : '';
  lines.push(`  Carrier: ${escapeHtml(carrier + tech)}`);
  if (cfg.operator?.selectionModeLabel) {
    lines.push(`  Selection: ${escapeHtml(cfg.operator.selectionModeLabel)}`);
  }
  if (cfg.registration) {
    const roaming = cfg.registration.roaming ? ' 🌍' : '';
    lines.push(`  Status: ${escapeHtml(cfg.registration.description)}${roaming}`);
  }
  if (cfg.networkMode) lines.push(`  Radio: ${escapeHtml(cfg.networkMode.label)}`);
  if (cfg.lteMode) lines.push(`  LTE-IoT: ${escapeHtml(cfg.lteMode.label)}`);
  if (cfg.lastError) lines.push(`  Last error: <code>${escapeHtml(cfg.lastError)}</code>`);

  // A manual lock that is not registered is the state worth shouting about: the
  // module will sit there indefinitely rather than trying anything else.
  if (cfg.operator?.selectionMode === 1 && cfg.registration?.registered === false) {
    lines.push(
      '',
      '⚠️ <b>Locked to a carrier and not registered.</b> This modem will not try',
      'any other network on its own. Use <code>/network auto</code> to release the lock.',
    );
  }

  // Registration denied means the network answered and refused, so the radio path
  // is fine — point at the two things that actually explain it.
  if (cfg.registration?.stat === 3) {
    lines.push(
      '',
      '⚠️ <b>Registration denied</b> — the network refused the attach, so this is',
      'not a signal or driver problem. Run <code>/network scan</code>: if this carrier',
      'shows as <i>forbidden</i>, the SIM is not permitted on it. Otherwise try a',
      'different <code>/network rat</code> — carriers provision Cat-M and NB-IoT separately.',
    );
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

async function runScan(
  ctx: { reply: (t: string, o?: object) => Promise<unknown> },
  modem: Modem,
): Promise<void> {
  await ctx.reply(
    `Scanning on <b>${escapeHtml(modem.label)}</b>… this takes up to two minutes ` +
      'and drops the current registration.',
    { parse_mode: 'HTML' },
  );

  const found = await modem.scanNetworks();
  if (found.length === 0) {
    await ctx.reply('No networks visible. Check the antenna and the band configuration.');
    return;
  }

  const keyboard = new InlineKeyboard();
  const lines = [`<b>${escapeHtml(modem.label)} — ${found.length} network(s)</b>`, ''];

  for (const op of found) {
    const icon = op.forbidden ? '⛔' : op.status === 2 ? '●' : '○';
    const tech = op.actLabel ? ` · ${op.actLabel}` : '';
    lines.push(
      `${icon} <b>${escapeHtml(op.longName || op.plmn)}</b> <code>${escapeHtml(op.plmn)}</code>` +
        `${escapeHtml(tech)} — ${escapeHtml(op.statusLabel)}`,
    );
    // A forbidden network will refuse the attach however it is selected.
    if (!op.forbidden) {
      keyboard
        .text(
          `${op.longName || op.plmn}${op.actLabel ? ` (${op.actLabel})` : ''}`,
          `${CALLBACK_PREFIX}${modem.id}:${op.plmn}:${op.act ?? ''}`,
        )
        .row();
    }
  }

  if (found.some((o) => o.forbidden)) {
    lines.push(
      '',
      '⛔ <b>forbidden</b> means the network refused this SIM — a carrier-side',
      'answer that no modem setting will change.',
    );
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
  });
}

async function useNetwork(
  ctx: { reply: (t: string, o?: object) => Promise<unknown> },
  modem: Modem,
  rest: string[],
): Promise<void> {
  const plmn = rest[0];
  if (!plmn) {
    await ctx.reply(`Give a numeric PLMN, e.g. <code>/network use 302610 catm</code>`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const techName = rest[1]?.toLowerCase();
  let act: number | undefined;
  if (techName !== undefined) {
    act = ACCESS_TECHNOLOGIES[techName];
    if (act === undefined) {
      await ctx.reply(
        `Unknown technology <code>${escapeHtml(techName)}</code>. Use one of: ${Object.keys(ACCESS_TECHNOLOGIES).join(', ')}.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
  }

  await ctx.reply(`Locking to <code>${escapeHtml(plmn)}</code>…`, { parse_mode: 'HTML' });
  try {
    await modem.selectNetwork(plmn, act);
  } catch (err) {
    const message = (err as Error).message;
    if (diagnoseChannelLoss(message)) throw err;
    await ctx.reply(lockFailure(modem.label, plmn, message), { parse_mode: 'HTML' });
    return;
  }
  await ctx.reply(
    `✅ <b>${escapeHtml(modem.label)}</b> locked to <code>${escapeHtml(plmn)}</code>.\n` +
      LOCKED_NOTE,
    { parse_mode: 'HTML' },
  );
}

async function setMode(
  ctx: { reply: (t: string, o?: object) => Promise<unknown> },
  modem: Modem,
  name: string | undefined,
  names: Record<string, number>,
  labels: Record<number, string>,
  apply: (value: number) => Promise<void>,
): Promise<void> {
  const key = name?.toLowerCase();
  const value = key === undefined ? undefined : names[key];

  if (value === undefined) {
    await ctx.reply(`Choose one of: ${Object.keys(names).join(', ')}.`);
    return;
  }

  await apply(value);
  await ctx.reply(
    `✅ <b>${escapeHtml(modem.label)}</b> set to <b>${escapeHtml(labels[value] ?? String(value))}</b>.\n` +
      '<i>Saved to the module and kept across reboots. Re-registration may take a moment.</i>',
    { parse_mode: 'HTML' },
  );
}
