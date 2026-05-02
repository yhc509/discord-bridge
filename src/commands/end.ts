import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getWorkspaceByChannel } from '../config.js';
import type { SlashCommand } from './types.js';

export const endCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('end')
    .setDescription('End the current session')
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
    if (status.state === 'idle' && status.messageCount === 0) {
      await interaction.reply('No active session to end.');
      return;
    }

    await interaction.deferReply();
    await sessions.stop(workspace.name);

    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('✅ Session ended');

    await interaction.editReply({ embeds: [embed] });
  },
};
