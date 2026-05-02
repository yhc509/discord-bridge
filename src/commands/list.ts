import { SlashCommandBuilder } from 'discord.js';
import type { WorkspaceStatus } from '../session/manager.js';
import type { SlashCommand } from './types.js';

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function statusIcon(status: WorkspaceStatus): string {
  if (status.state === 'error') {
    return '🔴';
  }

  if (status.state === 'running' || status.state === 'waiting') {
    return '🟢';
  }

  return '⚫';
}

function formatStatus(status: WorkspaceStatus, nameWidth: number, now: number): string {
  const icon = statusIcon(status);
  const name = status.workspace.padEnd(nameWidth, ' ');

  const providerTag = status.provider === 'codex' ? ' [codex]' : '';
  const restoredTag = status.restoredFromDisk ? ' [restored]' : '';

  if (
    (status.state === 'running' || status.state === 'waiting') &&
    status.startedAt
  ) {
    const duration = formatDuration(now - status.startedAt.getTime());
    return `${icon} ${name} · ${status.state} (${duration})${providerTag}${restoredTag}`;
  }

  if (status.state === 'idle') {
    return `${icon} ${name} · stopped${providerTag}${restoredTag}`;
  }

  return `${icon} ${name} · ${status.state}${providerTag}${restoredTag}`;
}

export const listCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('list')
    .setDescription('Show all workspace statuses')
    .toJSON(),

  async execute(interaction, { sessions }) {
    const statuses = sessions.listAll();
    const nameWidth = statuses.reduce(
      (width, status) => Math.max(width, status.workspace.length),
      0,
    );
    const now = Date.now();
    const lines = statuses.map((status) => formatStatus(status, nameWidth, now));

    await interaction.reply(`\`\`\`\n${lines.join('\n')}\n\`\`\``);
  },
};
