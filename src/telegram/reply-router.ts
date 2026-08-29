import type { BotDeps, GatewayBot } from './deps.js';
import { deliver } from './commands/send.js';
import { escapeHtml } from './format.js';

/**
 * Routes a native Telegram reply back out as an SMS.
 *
 * Replying to a posted SMS answers that sender on the modem that received it —
 * deliberately ignoring the chat's `/select`, since replying on a different SIM
 * would reach the contact from an unexpected number.
 */
export function registerReplyRouter(bot: GatewayBot, deps: BotDeps): void {
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return next();

    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) {
      await ctx.reply(
        'Reply to a received SMS to answer it, or use <code>/send &lt;number&gt; &lt;text&gt;</code>.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const original = deps.repo.lookupTelegramMessage(ctx.chat.id, replyTo.message_id);
    if (!original) {
      await ctx.reply(
        "That message isn't linked to an SMS conversation. Use <code>/send &lt;number&gt; &lt;text&gt;</code>.",
        { parse_mode: 'HTML' },
      );
      return;
    }

    const modem = deps.registry.byId(original.modem_id);
    if (!modem) {
      const label = deps.repo.getModem(original.modem_id)?.label ?? 'that SIM';
      await ctx.reply(
        `The SIM that received this message (<b>${escapeHtml(label)}</b>) is not currently attached.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await deliver(ctx, deps, modem, original.peer_number, text);
  });
}
