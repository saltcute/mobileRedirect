import { Bot, GrammyError, HttpError } from 'grammy';
import type { BotDeps, GatewayBot } from './deps.js';
import { registerSelect } from './commands/select.js';
import { registerSend } from './commands/send.js';
import { registerHistory } from './commands/history.js';
import { registerStatus } from './commands/status.js';
import { registerNetwork } from './commands/network.js';
import { registerReplyRouter } from './reply-router.js';
import { formatIncomingSms } from './format.js';
import { Notifier } from './notify.js';
import * as alerts from './alerts.js';
import type { IncomingSms } from '../modem/sms-rx.js';
import type { Modem } from '../modem/modem.js';

const HELP = [
  '<b>SMS ↔ Telegram gateway</b>',
  '',
  '/select — choose which SIM to use',
  '/send <code>&lt;number&gt; &lt;text&gt;</code> — send an SMS',
  '/history <code>[n|all]</code> — recent messages',
  '/status — signal, carrier, roaming, network',
  '/network — carrier selection and radio settings (<code>/network</code> for options)',
  '',
  'Incoming SMS are posted here. <b>Reply to one</b> to answer that sender on the SIM that received it.',
].join('\n');

export interface Gateway {
  bot: GatewayBot;
  /** Post an inbound SMS to every notify chat and link it for swipe-replies. */
  publishSms: (sms: IncomingSms, modem: Modem) => Promise<void>;
  /** Push operational events to the operators' DMs. */
  notifier: Notifier;
  notifyChatIds: number[];
}

export function createBot(deps: BotDeps): Gateway {
  const bot = new Bot(deps.config.TELEGRAM_BOT_TOKEN);
  const allowed = new Set(deps.config.ALLOWED_USER_IDS);

  // Alerts go to the operators directly, never to NOTIFY_CHAT_IDS: a shared SMS
  // group should not collect brownout reports, and an alert must never sit in a
  // chat where replying to it would send an SMS.
  const notifier = new Notifier({
    bot,
    chatIds: deps.config.ALLOWED_USER_IDS,
    setting: deps.config.NOTIFY_EVENTS,
    logger: deps.logger,
  });

  /**
   * Authorisation gate.
   *
   * Registered before every handler: this bot can send SMS billed to the owner's
   * SIM, so an unlisted user must never reach a command handler. Anything not on
   * the allowlist stops here.
   */
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== undefined && allowed.has(userId)) return next();

    deps.logger.warn(
      { userId, username: ctx.from?.username, chatId: ctx.chat?.id },
      'rejected unauthorised telegram user',
    );
    void notifier.send(alerts.unauthorised(userId, ctx.from?.username, ctx.chat?.id));
    if (ctx.chat) {
      await ctx.reply('Not authorised.').catch(() => undefined);
    }
  });

  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(HELP, { parse_mode: 'HTML' });
  });

  registerSelect(bot, deps);
  registerSend(bot, deps);
  registerHistory(bot, deps);
  registerStatus(bot, deps);
  registerNetwork(bot, deps);
  // Must come last: it claims plain text messages that no command matched.
  registerReplyRouter(bot, deps);

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      deps.logger.error({ description: e.description }, 'telegram api error');
    } else if (e instanceof HttpError) {
      deps.logger.error({ err: e.message }, 'telegram network error');
    } else {
      deps.logger.error({ err: (e as Error)?.message ?? String(e) }, 'bot handler error');
    }
  });

  // Default to a DM with each allowed user when no explicit notify chat is set.
  const notifyChatIds =
    deps.config.NOTIFY_CHAT_IDS && deps.config.NOTIFY_CHAT_IDS.length > 0
      ? deps.config.NOTIFY_CHAT_IDS
      : deps.config.ALLOWED_USER_IDS;

  const publishSms = async (sms: IncomingSms, modem: Modem): Promise<void> => {
    const body = formatIncomingSms(sms, modem.label);
    for (const chatId of notifyChatIds) {
      try {
        const sent = await bot.api.sendMessage(chatId, body, { parse_mode: 'HTML' });
        // Link the posted message so a swipe-reply can find its way back to the
        // sender and the modem that received it.
        deps.repo.mapTelegramMessage(chatId, sent.message_id, sms.messageId);
      } catch (err) {
        deps.logger.error(
          { chatId, err: (err as Error).message },
          'failed to deliver sms to telegram',
        );
      }
    }
  };

  return { bot, publishSms, notifier, notifyChatIds };
}

export async function publishCommandMenu(bot: GatewayBot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'select', description: 'Choose which SIM to use' },
    { command: 'send', description: 'Send an SMS: /send <number> <text>' },
    { command: 'history', description: 'Recent messages' },
    { command: 'status', description: 'Signal, carrier, roaming, network' },
    { command: 'network', description: 'Carrier selection and radio settings' },
    { command: 'help', description: 'Show usage' },
  ]);
}
