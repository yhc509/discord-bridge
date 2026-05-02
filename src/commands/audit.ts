import {
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js';

import {
  auditSecurity,
  type AuditFinding,
  type AuditSection,
  type AuditSeverity,
} from '../security-audit.js';
import type { SlashCommand } from './types.js';

const severityColor: Record<AuditSeverity, number> = {
  ok: 0x22c55e,
  warning: 0xf59e0b,
  critical: 0xef4444,
};

const severityIcon: Record<AuditSeverity, string> = {
  ok: '✅',
  warning: '⚠️',
  critical: '❌',
};

function truncate(value: string, max = 1024): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 3)}...`;
}

function formatFinding(finding: AuditFinding): string {
  const line = `${severityIcon[finding.severity]} ${finding.title}`;
  return finding.detail === undefined ? line : `${line}\n${finding.detail}`;
}

function formatSection(section: AuditSection): string {
  return truncate(section.findings.map(formatFinding).join('\n'));
}

export const auditCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Check channel, workspace, and bridge security settings')
    .toJSON(),

  async execute(interaction, { cfg, configPath }) {
    if (interaction.guildId !== cfg.discord.guild_id) {
      await interaction.reply({
        content: '❌ This command can only run in the configured Discord server.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.guild === null) {
      await interaction.reply({
        content: '❌ Run /audit from a server text channel.',
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.channel;
    if (channel === null || channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: '❌ Run /audit from a server text channel.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const audit = await auditSecurity({
      cfg,
      configPath,
      guild: interaction.guild,
      channel: channel as TextChannel,
      botMember: interaction.guild.members.me,
    });

    const embed = new EmbedBuilder()
      .setColor(severityColor[audit.severity])
      .setTitle(`Security audit · #${channel.name}`)
      .setDescription(`Overall status: ${severityIcon[audit.severity]} ${audit.severity}`);

    for (const section of audit.sections) {
      embed.addFields({
        name: section.title,
        value: formatSection(section),
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
