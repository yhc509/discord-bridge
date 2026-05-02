import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getWorkspaceByChannel } from '../config.js';
import type { SendPromptOptions } from '../session/manager.js';
import type { SessionManager } from '../session/manager.js';
import type { ClaudeEvent } from '../session/parser.js';
import type { SlashCommand } from './types.js';

const COMPACT_SUMMARY_PROMPT = [
  'We are manually compacting this session to shrink future context usage.',
  'The visible user prompt for this turn is only a transport trigger; ignore it and do not mention it in the brief.',
  'Do not use tools. Do not edit files. Do not run commands.',
  'Write only a concise markdown continuation brief for the next fresh session.',
  'Include: current goal, important state, files touched if relevant, open issues, and the next best step.',
  'Preserve exact filenames, commands, IDs, and constraints when they matter.',
  'Do not add preamble or commentary outside the brief.',
].join('\n');

function buildSeedPrompt(summary: string): string {
  return [
    'This is a fresh session created from a manual compact.',
    'Use the summary below as the prior context for future turns.',
    'Do not repeat the summary unless the user asks.',
    'Do not use tools for this turn.',
    'Reply with exactly: Compact complete. Ready to continue.',
    '',
    '### Compacted session context',
    summary,
  ].join('\n');
}

async function collectAssistantText(
  sessions: SessionManager,
  workspace: string,
  prompt: string,
  opts: SendPromptOptions = {},
): Promise<string> {
  let text = '';

  for await (const event of sessions.sendPrompt(workspace, prompt, opts)) {
    if (event.type === 'text_delta') {
      text += event.text;
      continue;
    }

    if (event.type === 'queued') {
      throw new Error('Session became busy while compacting.');
    }

    if (event.type === 'error' && event.fatal) {
      throw new Error(event.message);
    }
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('Provider returned an empty compact summary.');
  }

  return trimmed;
}

export const compactCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('compact')
    .setDescription('Compact the current session into a fresh one')
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
    if (status.messageCount === 0 && status.sessionId === undefined) {
      await interaction.reply({
        content: 'No active session to compact.',
        ephemeral: true,
      });
      return;
    }

    if (status.state === 'running') {
      await interaction.reply({
        content: '❌ A turn is still running. Wait for it to finish or use /interrupt first.',
        ephemeral: true,
      });
      return;
    }

    if (status.queuedCount > 0) {
      await interaction.reply({
        content: '❌ There are queued follow-up messages. Clear them first with /queue.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const summary = await collectAssistantText(
        sessions,
        workspace.name,
        '.',
        {
          hiddenInstructions: COMPACT_SUMMARY_PROMPT,
          internalMode: true,
        },
      );

      await sessions.reset(workspace.name, status.provider);
      await collectAssistantText(
        sessions,
        workspace.name,
        buildSeedPrompt(summary),
        {
          internalMode: true,
        },
      );

      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🗜️ Session compacted')
        .setDescription(
          `Workspace: \`${workspace.name}\` · Provider: \`${status.provider}\`\nStarted a fresh session from a compact summary.`,
        )
        .addFields({
          name: 'Summary size',
          value: `${summary.length} chars`,
          inline: true,
        });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const embed = new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle('❌ Compact failed')
        .setDescription(message);
      await interaction.editReply({ embeds: [embed] });
    }
  },
};
