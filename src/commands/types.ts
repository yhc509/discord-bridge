import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Config } from '../config.js';
import type { SessionManager } from '../session/manager.js';
import type { DiscordStreamer } from '../stream.js';

export interface CommandDeps {
  cfg: Config;
  configPath: string;
  hooksFilePath: string;
  sessions: SessionManager;
  streamer: DiscordStreamer;
  reloadConfig: () => Promise<{ added: string[]; removed: string[]; changed: string[] }>;
}

export interface SlashCommand {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
}

export interface ButtonHandler {
  customIdPrefix: string;
  handle(interaction: ButtonInteraction, deps: CommandDeps): Promise<void>;
}
