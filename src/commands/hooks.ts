import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

import { getWorkspaceByChannel } from '../config.js';
import { addHook, cancelHook, listHooks, type ScheduledHook } from '../scheduled-hooks.js';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'hook command failed';
}

export const hooksCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('hooks')
    .setDescription('Add, list, or cancel scheduled hooks for this workspace')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add a scheduled hook for this workspace')
        .addStringOption((option) =>
          option
            .setName('id')
            .setDescription('Hook ID')
            .setMinLength(1)
            .setMaxLength(64)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('at')
            .setDescription('ISO time with timezone, e.g. 2026-05-07T09:00:00+09:00')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('message')
            .setDescription('Reminder message')
            .setMaxLength(1800)
            .setRequired(true),
        ),
    )
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

    if (subcommand === 'add') {
      const id = interaction.options.getString('id', true);
      const runAt = interaction.options.getString('at', true);
      const message = interaction.options.getString('message', true);
      let hook: ScheduledHook;

      try {
        hook = await addHook(
          hooksFilePath,
          {
            id,
            workspace: workspace.name,
            run_at: runAt,
            message,
            created_by: `discord:${interaction.user.id}`,
          },
          cfg.hooks,
        );
      } catch (error) {
        await interaction.reply({
          content: `❌ ${errorMessage(error)}`,
          ephemeral: true,
        });
        return;
      }

      const timestamp = Math.floor(Date.parse(hook.run_at) / 1000);

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Hook scheduled')
            .setDescription(hook.message)
            .addFields(
              { name: 'ID', value: `\`${hook.id}\``, inline: true },
              { name: 'When', value: `<t:${timestamp}:F>`, inline: true },
            )
            .setColor(0x22c55e),
        ],
        ephemeral: true,
      });
      return;
    }

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
      let hook: ScheduledHook;

      try {
        hook = await cancelHook(hooksFilePath, workspace.name, id);
      } catch (error) {
        await interaction.reply({
          content: `❌ ${errorMessage(error)}`,
          ephemeral: true,
        });
        return;
      }

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
