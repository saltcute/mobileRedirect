import type { Bot, Context } from 'grammy';
import type { ModemRegistry } from '../modem/registry.js';
import type { Modem } from '../modem/modem.js';
import type { Repo } from '../store/repo.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

export interface BotDeps {
  registry: ModemRegistry;
  repo: Repo;
  config: Config;
  logger: Logger;
}

export type GatewayBot = Bot<Context>;

/**
 * The modem a chat acts on: its explicit `/select`, or the only attached module
 * when there is exactly one (so single-SIM setups never need to select).
 */
export function resolveModem(deps: BotDeps, chatId: number): Modem | null {
  const selectedId = deps.repo.getSelectedModem(chatId);
  if (selectedId !== null) {
    const modem = deps.registry.byId(selectedId);
    if (modem) return modem;
  }
  const all = deps.registry.list();
  return all.length === 1 ? (all[0] ?? null) : null;
}

export function noModemMessage(deps: BotDeps): string {
  if (deps.registry.size === 0) {
    return 'No modems are attached. Check the USB connection and `journalctl` for port errors.';
  }
  return 'No SIM selected. Use /select to choose one.';
}
