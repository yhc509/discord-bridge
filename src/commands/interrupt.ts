import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getWorkspaceByChannel } from '../config.js';
import type { SlashCommand } from './types.js';

export const interruptCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('interrupt')
    .setDescription('Interrupt the current running turn without ending the session')
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
    const interrupted = await sessions.interruptTurn(workspace.name);

    const embed = new EmbedBuilder()
      .setColor(interrupted ? 0xf59e0b : 0x3b82f6)
      .setTitle(interrupted ? '⏹ Turn interrupted' : 'No running turn to interrupt');

    await interaction.editReply({ embeds: [embed] });
  },
};
