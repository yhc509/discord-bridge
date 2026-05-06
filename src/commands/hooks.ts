import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

import { getWorkspaceByChannel } from '../config.js';
import { cancelHook, listHooks, type ScheduledHook } from '../scheduled-hooks.js';
import type { SlashCommand } from './types.js';

function formatHookLine(hook: ScheduledHook): string {
  const timestamp = Math.floor(Date.parse(hook.run_at) / 1000);
  const message =
    hook.message.length > 120 ? `${hook.message.slice(0, 117)}...` : hook.message;

  return `\`${hook.id}\` · <t:${timestamp}:F> · ${hook.status}\n${message}`;
}

function hooksDescription(hooks: ScheduledHook[]): string {
  if (hooks.length === 0) {
    return 'No scheduled hooks.';
  }

  const lines = hooks.slice(0, 10).map(formatHookLine);
  const remaining = hooks.length - lines.length;
  return remaining > 0 ? `${lines.join('\n\n')}\n\n+${remaining} more` : lines.join('\n\n');
}

export const hooksCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('hooks')
    .setDescription('List or cancel scheduled hooks for this workspace')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('List scheduled hooks for this workspace')
        .addBooleanOption((option) =>
          option
            .setName('all')
            .setDescription('Include delivered, canceled, missed, and failed hooks'),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cancel')
        .setDescription('Cancel a scheduled hook')
        .addStringOption((option) =>
          option
            .setName('id')
            .setDescription('Hook ID')
            .setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, { cfg, hooksFilePath }) {
    const workspace = getWorkspaceByChannel(cfg, interaction.channelId);
    if (!workspace) {
      await interaction.reply({
        content: '❌ This channel is not mapped to any workspace.',
        ephemeral: true,
      });
      return;
    }

    if (!cfg.hooks.enabled) {
      await interaction.reply({
        content: '❌ Scheduled hooks are disabled.',
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      const includeDone = interaction.options.getBoolean('all') ?? false;
      const hooks = await listHooks(hooksFilePath, {
        workspace: workspace.name,
        includeDone,
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Hooks · ${workspace.name}`)
            .setDescription(hooksDescription(hooks))
            .setColor(0x3b82f6),
        ],
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'cancel') {
      const id = interaction.options.getString('id', true);
      const hook = await cancelHook(hooksFilePath, workspace.name, id);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Hook canceled')
            .setDescription(`\`${hook.id}\` was canceled.`)
            .setColor(0x6b7280),
        ],
        ephemeral: true,
      });
    }
  },
};
