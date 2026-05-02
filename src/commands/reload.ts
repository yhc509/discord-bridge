import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const reloadCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('reload')
    .setDescription('Reload config.json workspaces')
    .toJSON(),

  async execute(interaction, { reloadConfig }) {
    await interaction.deferReply();

    try {
      const summary = await reloadConfig();
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🟢 Config reloaded')
        .addFields(
          { name: 'Added', value: String(summary.added.length), inline: true },
          { name: 'Removed', value: String(summary.removed.length), inline: true },
          { name: 'Changed', value: String(summary.changed.length), inline: true },
        );

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      const embed = new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle('❌ Config reload failed')
        .setDescription(errorMessage(error));

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
