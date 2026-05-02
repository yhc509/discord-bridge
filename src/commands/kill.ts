import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { getWorkspaceByChannel } from '../config.js';
import type { ButtonHandler, SlashCommand } from './types.js';

export const killCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('kill')
    .setDescription('Force kill session (requires confirmation)')
    .toJSON(),

  async execute(interaction, { cfg }) {
    const workspace = getWorkspaceByChannel(cfg, interaction.channelId);
    if (!workspace) {
      await interaction.reply({
        content: '❌ This channel is not mapped to any workspace.',
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('⚠️ Confirm force kill')
      .setDescription(`Confirm force kill of workspace \`${workspace.name}\`.`);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`kill-confirm:${workspace.name}`)
        .setLabel('Yes')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`kill-cancel:${workspace.name}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  },
};

const confirmHandler: ButtonHandler = {
  customIdPrefix: 'kill-confirm:',

  async handle(interaction, { sessions }) {
    const name = interaction.customId.slice(this.customIdPrefix.length);
    await sessions.forceKill(name);

    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle('🚫 Session killed');

    await interaction.update({ embeds: [embed], components: [] });
  },
};

const cancelHandler: ButtonHandler = {
  customIdPrefix: 'kill-cancel:',

  async handle(interaction) {
    const embed = new EmbedBuilder().setColor(0x3b82f6).setTitle('Cancelled.');
    await interaction.update({ embeds: [embed], components: [] });
  },
};

export const buttonHandlers: ButtonHandler[] = [confirmHandler, cancelHandler];
