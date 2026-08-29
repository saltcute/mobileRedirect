import { InlineKeyboard } from 'grammy';
import type { BotDeps, GatewayBot } from '../deps.js';
import { escapeHtml, signalBars } from '../format.js';

const CALLBACK_PREFIX = 'select:';

export function registerSelect(bot: GatewayBot, deps: BotDeps): void {
  bot.command('select', async (ctx) => {
    const modems = deps.registry.list();
    if (modems.length === 0) {
      await ctx.reply('No modems are attached.');
      return;
    }

    const current = deps.repo.getSelectedModem(ctx.chat.id);
    const keyboard = new InlineKeyboard();

    for (const modem of modems) {
      let suffix = '';
      try {
        const { carrier, bars } = await modem.summary();
        suffix = ` — ${carrier ?? 'no carrier'} ${signalBars(bars)}`;
      } catch {
        suffix = ' — unreachable';
      }
      const mark = modem.id === current ? '● ' : '○ ';
      keyboard.text(`${mark}${modem.label}${suffix}`, `${CALLBACK_PREFIX}${modem.id}`).row();
    }

    await ctx.reply('Select a SIM:', { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${CALLBACK_PREFIX}\\d+$`), async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await ctx.answerCallbackQuery({ text: 'Cannot select a SIM here.' });
      return;
    }

    const id = Number(ctx.callbackQuery.data.slice(CALLBACK_PREFIX.length));
    const modem = deps.registry.byId(id);

    if (!modem) {
      await ctx.answerCallbackQuery({ text: 'That modem is no longer attached.' });
      return;
    }

    deps.repo.setSelectedModem(chatId, id);
    await ctx.answerCallbackQuery({ text: `Selected ${modem.label}` });
    await ctx.editMessageText(`Selected <b>${escapeHtml(modem.label)}</b>`, {
      parse_mode: 'HTML',
    });
  });
}
