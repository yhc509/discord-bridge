import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getWorkspaceByChannel } from '../config.js';
import type { SlashCommand } from './types.js';

function relativeTimestamp(value: Date | number | string): string {
  const unix = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${unix}:R>`;
}

function formatPreview(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  const truncated =
    escaped.length > 900 ? `${escaped.slice(0, 897).replace(/\\+$/, '')}...` : escaped;

  return `\`${truncated}\``;
}

export const queueCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Inspect or manage queued follow-up messages')
    .addSubcommand((sub) => sub.setName('list').setDescription('List queued follow-up messages'))
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel one queued follow-up by id')
        .addStringOption((option) =>
          option.setName('id').setDescription('Queue item id from /queue list').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('Clear every queued follow-up'))
    .toJSON(),

  async execute(interaction, { cfg, sessions }) {
    const workspace = getWorkspaceByChannel(cfg, interaction.channelId);
    if (!workspace) {
      await interaction.reply({
        content: '❌ This channel is not mapped to any workspace.',
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const queued = sessions.queuedPrompts(workspace.name);

    if (subcommand === 'list') {
      const embed = new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`Queue · ${workspace.name}`);

      if (queued.length === 0) {
        embed.setDescription('No queued follow-up messages.');
      } else {
        embed.setDescription(
          queued
            .map(
              (item) =>
                `\`${item.id}\` · ${relativeTimestamp(item.queuedAt)}\n${formatPreview(item.preview)}`,
            )
            .join('\n\n'),
        );
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (subcommand === 'cancel') {
      const id = interaction.options.getString('id', true).trim();
      const removed = sessions.cancelQueuedPrompt(workspace.name, id);
      const embed = new EmbedBuilder()
        .setColor(removed ? 0xf59e0b : 0x3b82f6)
        .setTitle(removed ? `🗑️ Removed queued item ${id}` : `Queue item not found: ${id}`);

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    const cleared = sessions.clearQueuedPrompts(workspace.name);
    const embed = new EmbedBuilder()
      .setColor(cleared > 0 ? 0xf59e0b : 0x3b82f6)
      .setTitle(cleared > 0 ? `🧹 Cleared ${cleared} queued message(s)` : 'Queue already empty');

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
