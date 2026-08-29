import type { BotDeps, GatewayBot } from '../deps.js';
import { formatStatus } from '../format.js';

export function registerStatus(bot: GatewayBot, deps: BotDeps): void {
  bot.command('status', async (ctx) => {
    const modems = deps.registry.list();
    if (modems.length === 0) {
      await ctx.reply('No modems are attached.');
      return;
    }

    const notice = await ctx.reply('Querying modems…');
    const blocks: string[] = [];

    for (const modem of modems) {
      try {
        blocks.push(formatStatus(await modem.status()));
      } catch (err) {
        blocks.push(`<b>${modem.label}</b>\n  ⚠️ unreachable: ${(err as Error).message}`);
      }
    }

    await ctx.api.editMessageText(ctx.chat.id, notice.message_id, blocks.join('\n\n'), {
      parse_mode: 'HTML',
    });
  });
}
