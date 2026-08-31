import type { GatewayBot } from './deps.js';
import type { Logger } from '../logger.js';

export type NotifyLevel = 'critical' | 'normal' | 'verbose';
export type NotifySetting = 'off' | NotifyLevel;

/** Lower is more urgent. A notification is sent when its rank <= the setting's. */
const RANK: Record<NotifyLevel, number> = { critical: 0, normal: 1, verbose: 2 };

export interface Notification {
  /**
   * Throttle bucket. Events that can repeat indefinitely (a port that will not
   * open, a stranger retrying) set one; genuine edge transitions leave it unset,
   * because they are already emitted once per change.
   */
  key?: string;
  level: NotifyLevel;
  /** Telegram HTML. Interpolated values must be escaped by the caller. */
  text: string;
}

/** How long one throttled key stays quiet after firing. */
const THROTTLE_MS = 15 * 60_000;
/** Backstop against a flapping module: messages allowed in any 60s window. */
const RATE_LIMIT_PER_MINUTE = 12;

export interface NotifierOptions {
  bot: GatewayBot;
  chatIds: number[];
  setting: NotifySetting;
  logger: Logger;
  throttleMs?: number;
  ratePerMinute?: number;
}

/**
 * Pushes operational events to the operators' DMs.
 *
 * Separate from `publishSms` on purpose: alerts are deliberately *not* recorded
 * in `tg_map`, so replying to one cannot send an SMS to whoever was last heard
 * from.
 */
export class Notifier {
  private readonly bot: GatewayBot;
  private readonly chatIds: number[];
  private readonly setting: NotifySetting;
  private readonly log: Logger;
  private readonly throttleMs: number;
  private readonly ratePerMinute: number;

  private readonly throttle = new Map<string, { until: number; suppressed: number }>();
  /** Send times inside the current rate window. */
  private sentAt: number[] = [];
  private droppedToRateLimit = 0;

  constructor(opts: NotifierOptions) {
    this.bot = opts.bot;
    this.chatIds = opts.chatIds;
    this.setting = opts.setting;
    this.log = opts.logger.child({ component: 'notify' });
    this.throttleMs = opts.throttleMs ?? THROTTLE_MS;
    this.ratePerMinute = opts.ratePerMinute ?? RATE_LIMIT_PER_MINUTE;
  }

  get enabled(): boolean {
    return this.setting !== 'off';
  }

  /**
   * Deliver a notification. Never rejects.
   *
   * Callers normally fire and forget (`void notifier.send(...)`); shutdown awaits
   * it, because the process exits immediately afterwards.
   */
  async send(notification: Notification): Promise<void> {
    try {
      await this.deliver(notification);
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'notifier failed');
    }
  }

  private async deliver(notification: Notification): Promise<void> {
    if (this.setting === 'off') return;
    if (RANK[notification.level] > RANK[this.setting]) return;

    const now = Date.now();
    let suffix = '';

    // Every gate below runs before the first await, so concurrent sends cannot
    // interleave and let two messages through one slot.
    if (notification.key !== undefined) {
      const entry = this.throttle.get(notification.key);
      if (entry && now < entry.until) {
        entry.suppressed++;
        return;
      }
      if (entry && entry.suppressed > 0) {
        suffix += `\n<i>(+${entry.suppressed} more since the last alert)</i>`;
      }
      this.throttle.set(notification.key, { until: now + this.throttleMs, suppressed: 0 });
    }

    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= this.ratePerMinute) {
      this.droppedToRateLimit++;
      return;
    }
    this.sentAt.push(now);

    if (this.droppedToRateLimit > 0) {
      // Ride the count out on the next message that gets through, rather than
      // holding a timer open just to report silence.
      suffix += `\n<i>(…and ${this.droppedToRateLimit} other alerts dropped by the rate cap)</i>`;
      this.droppedToRateLimit = 0;
    }

    const text = notification.text + suffix;
    for (const chatId of this.chatIds) {
      try {
        await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        // Logged only. There is deliberately no path from a delivery failure
        // back into send(): a Telegram outage must not generate more Telegram
        // traffic trying to report itself.
        this.log.error(
          { chatId, err: (err as Error).message },
          'failed to deliver notification',
        );
      }
    }
  }
}
