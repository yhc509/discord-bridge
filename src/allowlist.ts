import type { Config } from './config.js';

export function isAllowed(userId: string, cfg: Config): boolean {
  return cfg.discord.user_allowlist.includes(userId);
}
