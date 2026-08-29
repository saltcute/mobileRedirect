import type { BotDeps, GatewayBot } from '../deps.js';
import { formatHistory } from '../format.js';
import { resolveModem } from '../deps.js';

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

export function registerHistory(bot: GatewayBot, deps: BotDeps): void {
  bot.command('history', async (ctx) => {
    const arg = ctx.match.trim();
    const all = arg === 'all';
    const requested = Number.parseInt(arg, 10);
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const modem = all ? null : resolveModem(deps, ctx.chat.id);
    if (!all && !modem) {
      await ctx.reply(
        'No SIM selected. Use /select, or /history all to see every SIM.',
      );
      return;
    }

    const messages = deps.repo.recentMessages(modem?.id ?? null, limit);
    const labels = new Map(deps.repo.listModems().map((m) => [m.id, m.label]));
    const scope = modem ? modem.label : 'all SIMs';

    const body = formatHistory(messages, (id) => labels.get(id) ?? `modem ${id}`);
    await ctx.reply(`<b>Last ${messages.length} — ${scope}</b>\n\n${body}`, {
      parse_mode: 'HTML',
    });
  });
}
