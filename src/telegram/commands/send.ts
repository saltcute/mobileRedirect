import type { BotDeps, GatewayBot } from '../deps.js';
import { noModemMessage, resolveModem } from '../deps.js';
import { escapeHtml } from '../format.js';
import { isValidDestination, normaliseNumber } from '../../modem/parse.js';
import type { Modem } from '../../modem/modem.js';

const USAGE = 'Usage: <code>/send +4915112345678 your message</code>';

export function registerSend(bot: GatewayBot, deps: BotDeps): void {
  bot.command('send', async (ctx) => {
    const raw = ctx.match.trim();
    if (raw.length === 0) {
      await ctx.reply(USAGE, { parse_mode: 'HTML' });
      return;
    }

    const separator = raw.search(/\s/);
    if (separator === -1) {
      await ctx.reply(`No message body given.\n${USAGE}`, { parse_mode: 'HTML' });
      return;
    }

    const destination = raw.slice(0, separator);
    const text = raw.slice(separator + 1).trim();

    if (!isValidDestination(destination)) {
      await ctx.reply(
        `<code>${escapeHtml(destination)}</code> is not a valid number.\n${USAGE}`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    if (text.length === 0) {
      await ctx.reply(`No message body given.\n${USAGE}`, { parse_mode: 'HTML' });
      return;
    }

    const modem = resolveModem(deps, ctx.chat.id);
    if (!modem) {
      await ctx.reply(noModemMessage(deps));
      return;
    }

    await deliver(ctx, deps, modem, destination, text);
  });
}

/** Shared by /send and the swipe-reply router. */
export async function deliver(
  ctx: { reply: (text: string, other?: Record<string, unknown>) => Promise<unknown> },
  deps: BotDeps,
  modem: Modem,
  destination: string,
  text: string,
): Promise<void> {
  const target = normaliseNumber(destination);

  try {
    // sendSms builds the PDU before issuing any AT command, so an unencodable
    // message or bad number fails here without touching the modem.
    const result = await modem.send(target, text);
    const detail =
      result.parts > 1
        ? `${result.parts} parts, ${result.encoding}`
        : String(result.encoding);
    await ctx.reply(
      `✅ Sent via <b>${escapeHtml(modem.label)}</b> → <code>${escapeHtml(target)}</code> (${escapeHtml(detail)})`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    const message = (err as Error).message;
    deps.logger.error({ modem: modem.label, target, err: message }, 'sms send failed');
    await ctx.reply(
      `❌ Send failed via <b>${escapeHtml(modem.label)}</b>: ${escapeHtml(message)}`,
      { parse_mode: 'HTML' },
    );
  }
}
