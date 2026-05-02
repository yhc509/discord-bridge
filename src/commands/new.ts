import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getWorkspaceByChannel, providerValues, type Provider } from '../config.js';
import type { SlashCommand } from './types.js';

function isProvider(value: string): value is Provider {
  return providerValues.some((provider) => provider === value);
}

export const newCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('new')
    .setDescription('Start an AI session in this channel')
    .addSubcommand((sub) =>
      sub.setName('claude').setDescription('Start a Claude session'),
    )
    .addSubcommand((sub) =>
      sub.setName('codex').setDescription('Start a Codex session'),
    )
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
    const subcommand = interaction.options.getSubcommand();
    const provider: Provider = isProvider(subcommand) ? subcommand : 'claude';
    const status = await sessions.reset(workspace.name, provider);

    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('🟢 Session started')
      .setDescription(
        `Workspace: \`${workspace.name}\` · Provider: \`${status.provider}\`\nReady for prompts in this channel.`,
      );

    await interaction.editReply({ embeds: [embed] });
  },
};
