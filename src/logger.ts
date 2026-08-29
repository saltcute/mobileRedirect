import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // systemd/journald already timestamps; keep the field for local runs.
  base: undefined,
});

export type Logger = pino.Logger;
