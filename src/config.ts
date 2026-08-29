import { z } from 'zod';

/** Comma-separated numeric Telegram IDs -> number[] */
const idList = z.string().transform((raw, ctx) => {
  const out: number[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const n = Number(trimmed);
    if (!Number.isInteger(n)) {
      ctx.addIssue({
        code: 'custom',
        message: `${JSON.stringify(trimmed)} is not a numeric Telegram ID`,
      });
      return z.NEVER;
    }
    out.push(n);
  }
  return out;
});

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20, 'TELEGRAM_BOT_TOKEN looks malformed'),

  /**
   * Numeric Telegram user IDs permitted to use the bot. This is the only thing
   * standing between a stranger and sending SMS billed to the owner's SIM, so an
   * empty list is a hard startup failure rather than a permissive default.
   */
  ALLOWED_USER_IDS: idList.refine(
    (v) => v.length > 0,
    'ALLOWED_USER_IDS must list at least one Telegram user ID',
  ),

  /** Chats that receive inbound SMS. Defaults to DMs with each allowed user. */
  NOTIFY_CHAT_IDS: idList.optional(),

  DB_PATH: z.string().default('./data/gateway.sqlite'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /** JSON object mapping ICCID (or IMEI) -> friendly label. */
  MODEM_LABELS: z
    .string()
    .default('{}')
    .transform((s, ctx) => {
      try {
        const parsed: unknown = JSON.parse(s);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        return parsed as Record<string, string>;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'MODEM_LABELS must be a JSON object' });
        return z.NEVER;
      }
    }),

  SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),

  /** How long to hold incomplete multipart SMS before flushing what arrived. */
  CONCAT_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
