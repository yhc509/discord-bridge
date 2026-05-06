import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from './types.js';

const commandDescriptions = [
  ['audit', 'Check channel and workspace security settings'],
  ['bind', 'Bind this channel to a local workspace'],
  ['new', 'Start an AI session in this channel'],
  ['compact', 'Shrink the current session into a fresh one'],
  ['end', 'End the current session'],
  ['kill', 'Force kill the current session'],
  ['usage', 'Show 5h / 7d usage for this workspace provider'],
  ['status', 'Show current channel workspace status'],
  ['list', 'Show all workspace statuses'],
  ['hooks list', 'List scheduled hooks for this workspace'],
  ['hooks cancel', 'Cancel a scheduled hook'],
  ['reload', 'Reload config.json workspaces'],
  ['unbind', 'Remove this channel workspace binding'],
  ['help', 'Show available commands'],
] as const;

export const helpCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands')
    .toJSON(),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('Available commands')
      .setDescription(
        commandDescriptions
          .map(([name, description]) => `/${name} · ${description}`)
          .join('\n'),
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
