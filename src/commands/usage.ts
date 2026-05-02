import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getWorkspaceByChannel } from '../config.js';
import { getProviderUsageSnapshot } from '../provider-usage.js';
import type { Provider } from '../config.js';
import type { SlashCommand } from './types.js';

function shortSessionId(sessionId: string | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : 'none';
}

function relativeTimestamp(value: Date | number | string): string {
  const unix = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${unix}:R>`;
}

function detailedTimestamp(value: Date | null): string {
  if (value === null) {
    return 'n/a';
  }

  const unix = Math.floor(value.getTime() / 1000);
  return `<t:${unix}:f> · <t:${unix}:R>`;
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function modelForProvider(provider: Provider, cfg: Parameters<SlashCommand['execute']>[1]['cfg']): string {
  return provider === 'codex' ? cfg.codex.model : cfg.claude.model;
}

export const usageCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('usage')
    .setDescription('Show 5h / 7d usage for the current workspace provider')
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

    await interaction.deferReply();

    const status = sessions.status(workspace.name);
    const usage = await getProviderUsageSnapshot(status.provider);
    const embed = new EmbedBuilder()
      .setColor(0x10b981)
      .setTitle(`Usage · ${workspace.name}`)
      .setDescription(
        status.provider === 'claude'
          ? 'Claude 5h / 7d plan usage.'
          : 'Codex 5h / 7d rate-limit usage from the latest local session snapshot.',
      )
      .addFields(
        { name: 'Provider', value: status.provider, inline: true },
        { name: 'Model', value: modelForProvider(status.provider, cfg), inline: true },
        { name: 'Plan', value: usage.planName ?? 'n/a', inline: true },
        { name: '5h used', value: formatPercent(usage.fiveHourUsedPercent), inline: true },
        { name: '5h resets', value: detailedTimestamp(usage.fiveHourResetAt), inline: true },
        { name: '7d used', value: formatPercent(usage.sevenDayUsedPercent), inline: true },
        { name: '7d resets', value: detailedTimestamp(usage.sevenDayResetAt), inline: true },
        { name: 'Source', value: usage.sourceLabel, inline: true },
        { name: 'Workspace state', value: status.state, inline: true },
        { name: 'Session ID', value: shortSessionId(status.sessionId), inline: true },
      );

    if (usage.capturedAt) {
      embed.addFields({
        name: 'Captured',
        value: relativeTimestamp(usage.capturedAt),
        inline: true,
      });
    }

    if (usage.unavailableReason) {
      embed.addFields({
        name: 'Note',
        value: usage.unavailableReason,
        inline: false,
      });
      embed.setColor(0xf59e0b);
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
