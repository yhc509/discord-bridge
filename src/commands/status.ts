import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getWorkspaceByChannel } from '../config.js';
import type { SlashCommand } from './types.js';

function relativeTimestamp(value: Date | number | string): string {
  const unix = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${unix}:R>`;
}

function shortSessionId(sessionId: string | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : 'none';
}

function formatPreview(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  const truncated =
    escaped.length > 900 ? `${escaped.slice(0, 897).replace(/\\+$/, '')}...` : escaped;

  return `\`${truncated}\``;
}

function formatPath(p: string): string {
  const escaped = p.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  const truncated =
    escaped.length > 900 ? `${escaped.slice(0, 897).replace(/\\+$/, '')}...` : escaped;

  return `\`${truncated}\``;
}

export const statusCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current channel workspace status')
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

    const status = sessions.status(workspace.name);
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`Status · ${workspace.name}`)
      .addFields(
        { name: 'State', value: status.state, inline: true },
        { name: 'Provider', value: status.provider, inline: true },
        { name: 'Restored', value: status.restoredFromDisk ? 'yes' : 'no', inline: true },
        { name: 'Queued', value: String(status.queuedCount), inline: true },
        { name: 'Messages', value: String(status.messageCount), inline: true },
        { name: 'Session ID', value: shortSessionId(status.sessionId), inline: true },
        { name: 'Working dir', value: formatPath(status.cwd), inline: false },
      );

    if (status.startedAt) {
      embed.addFields({
        name: 'Started',
        value: relativeTimestamp(status.startedAt),
        inline: true,
      });
    }

    if (status.lastPromptAt) {
      embed.addFields({
        name: 'Last prompt',
        value: relativeTimestamp(status.lastPromptAt),
        inline: true,
      });
    }

    if (status.lastPromptPreview) {
      embed.addFields({
        name: 'Last prompt preview',
        value: formatPreview(status.lastPromptPreview),
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
