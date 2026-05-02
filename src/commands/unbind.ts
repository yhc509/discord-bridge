import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { loadConfig, type Provider } from '../config.js';
import {
  applyWorkspaceUnbinding,
  previewWorkspaceUnbinding,
  type UnbindWorkspaceRequest,
  type UnbindWorkspacePreview,
} from '../workspace-binding.js';
import type { ButtonHandler, CommandDeps, SlashCommand } from './types.js';

const APPLY_PREFIX = 'unbind-apply:';
const CANCEL_PREFIX = 'unbind-cancel:';
const PENDING_UNBIND_TTL_MS = 5 * 60 * 1000;

interface PendingUnbind {
  id: string;
  userId: string;
  channelId: string;
  requestedAt: number;
  request: Omit<UnbindWorkspaceRequest, 'cfg'>;
}

const pendingUnbinds = new Map<string, PendingUnbind>();

function deleteExpiredPendingUnbinds(now = Date.now()): void {
  for (const [id, pending] of pendingUnbinds) {
    if (now - pending.requestedAt > PENDING_UNBIND_TTL_MS) {
      pendingUnbinds.delete(id);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCode(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  const truncated =
    escaped.length > 900 ? `${escaped.slice(0, 897).replace(/\\+$/, '')}...` : escaped;

  return `\`${truncated}\``;
}

function relativeConfigPath(configPath: string): string {
  const relative = path.relative(process.cwd(), configPath);

  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : configPath;
}

function assertWorkspaceIdle(
  deps: Pick<CommandDeps, 'sessions'>,
  workspaceName: string,
): void {
  const status = deps.sessions.status(workspaceName);
  if (status.state === 'idle' && status.queuedCount === 0) {
    return;
  }

  throw new Error('end or kill the current session before unbinding this channel');
}

function buildPreviewEmbed(
  pending: PendingUnbind,
  preview: UnbindWorkspacePreview,
): EmbedBuilder {
  const expiresAt = Math.floor((pending.requestedAt + PENDING_UNBIND_TTL_MS) / 1000);

  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('Unbind workspace?')
    .setDescription(
      `This removes the channel binding for ${formatCode(preview.workspace.name)}. Files stay on disk.`,
    )
    .addFields(
      { name: 'Provider', value: formatCode(preview.workspace.provider), inline: true },
      { name: 'Workspace', value: formatCode(preview.workspace.name), inline: true },
      { name: 'Working dir', value: formatCode(preview.workspace.cwd), inline: false },
      { name: 'Config', value: formatCode(relativeConfigPath(preview.configPath)), inline: false },
      { name: 'Expires', value: `<t:${expiresAt}:R>`, inline: true },
    );
}

function buildSuccessEmbed(result: {
  backupPath: string;
  workspace: { name: string; cwd: string; provider: Provider };
  configPath: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('Workspace unbound')
    .setDescription(`${formatCode(result.workspace.name)} is no longer bound to this channel.`)
    .addFields(
      { name: 'Workspace', value: formatCode(result.workspace.name), inline: true },
      { name: 'Working dir kept', value: formatCode(result.workspace.cwd), inline: false },
      { name: 'Config', value: formatCode(relativeConfigPath(result.configPath)), inline: false },
      { name: 'Backup', value: formatCode(relativeConfigPath(result.backupPath)), inline: false },
    );
}

function buildErrorEmbed(title: string, error: unknown): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(title)
    .setDescription(errorMessage(error));
}

function buildActionRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLY_PREFIX}${id}`)
      .setLabel('Apply')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CANCEL_PREFIX}${id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

function getPending(interactionUserId: string, channelId: string, id: string): PendingUnbind {
  deleteExpiredPendingUnbinds();

  const pending = pendingUnbinds.get(id);
  if (pending === undefined) {
    throw new Error('This unbind request expired. Run /unbind again.');
  }

  if (pending.userId !== interactionUserId) {
    throw new Error('Only the user who started this unbind request can use these buttons.');
  }

  if (pending.channelId !== channelId) {
    throw new Error('This unbind request belongs to a different channel.');
  }

  return pending;
}

export const unbindCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('unbind')
    .setDescription('Remove this channel workspace binding')
    .toJSON(),

  async execute(interaction, deps) {
    const { cfg, configPath } = deps;
    deleteExpiredPendingUnbinds();

    if (interaction.guildId !== cfg.discord.guild_id) {
      await interaction.reply({
        content: '❌ This command can only run in the configured Discord server.',
        ephemeral: true,
      });
      return;
    }

    const id = randomUUID();
    const pending: PendingUnbind = {
      id,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      requestedAt: Date.now(),
      request: {
        channelId: interaction.channelId,
        configPath,
      },
    };

    try {
      const preview = previewWorkspaceUnbinding({ cfg, ...pending.request });
      assertWorkspaceIdle(deps, preview.workspace.name);
      pendingUnbinds.set(id, pending);

      await interaction.reply({
        embeds: [buildPreviewEmbed(pending, preview)],
        components: [buildActionRow(id)],
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Unbind preview failed', error)],
        ephemeral: true,
      });
    }
  },
};

const applyHandler: ButtonHandler = {
  customIdPrefix: APPLY_PREFIX,

  async handle(interaction, deps) {
    const id = interaction.customId.slice(APPLY_PREFIX.length);

    try {
      const pending = getPending(interaction.user.id, interaction.channelId, id);
      const cfg = await loadConfig(pending.request.configPath);
      const preview = previewWorkspaceUnbinding({ cfg, ...pending.request });

      assertWorkspaceIdle(deps, preview.workspace.name);

      const result = await applyWorkspaceUnbinding(preview);
      pendingUnbinds.delete(id);

      try {
        await deps.reloadConfig();
      } catch (error) {
        await interaction.update({
          embeds: [
            buildSuccessEmbed(result)
              .setColor(0xf59e0b)
              .setTitle('Workspace unbound, reload failed')
              .addFields({ name: 'Reload error', value: errorMessage(error), inline: false }),
          ],
          components: [],
        });
        return;
      }

      await interaction.update({
        embeds: [buildSuccessEmbed(result)],
        components: [],
      });
    } catch (error) {
      await interaction.update({
        embeds: [buildErrorEmbed('Unbind failed', error)],
        components: [],
      });
    }
  },
};

const cancelHandler: ButtonHandler = {
  customIdPrefix: CANCEL_PREFIX,

  async handle(interaction) {
    const id = interaction.customId.slice(CANCEL_PREFIX.length);

    try {
      getPending(interaction.user.id, interaction.channelId, id);
      pendingUnbinds.delete(id);

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x6b7280)
            .setTitle('Unbind cancelled'),
        ],
        components: [],
      });
    } catch (error) {
      await interaction.update({
        embeds: [buildErrorEmbed('Unbind cancelled', error)],
        components: [],
      });
    }
  },
};

export const buttonHandlers: ButtonHandler[] = [applyHandler, cancelHandler];
