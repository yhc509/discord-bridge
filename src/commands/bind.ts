import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { loadConfig, providerValues, type Provider } from '../config.js';
import {
  DEFAULT_BIND_DEV_ROOT,
  DEFAULT_BIND_PROVIDER,
  applyWorkspaceBinding,
  previewWorkspaceBinding,
  type BindWorkspaceRequest,
} from '../workspace-binding.js';
import {
  auditBindPreview,
  type AuditFinding,
} from '../security-audit.js';
import type { ButtonHandler, CommandDeps, SlashCommand } from './types.js';

const APPLY_PREFIX = 'bind-apply:';
const CANCEL_PREFIX = 'bind-cancel:';
const PENDING_BIND_TTL_MS = 5 * 60 * 1000;

interface PendingBind {
  id: string;
  userId: string;
  channelId: string;
  requestedAt: number;
  request: Omit<BindWorkspaceRequest, 'cfg'>;
}

const pendingBinds = new Map<string, PendingBind>();

function createPendingId(): string {
  return randomUUID();
}

function deleteExpiredPendingBinds(now = Date.now()): void {
  for (const [id, pending] of pendingBinds) {
    if (now - pending.requestedAt > PENDING_BIND_TTL_MS) {
      pendingBinds.delete(id);
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

function isProvider(value: string): value is Provider {
  return providerValues.some((provider) => provider === value);
}

function buildPreviewEmbed(
  pending: PendingBind,
  preview: Awaited<ReturnType<typeof previewWorkspaceBinding>>,
  auditWarnings: AuditFinding[] = [],
): EmbedBuilder {
  const expiresAt = Math.floor((pending.requestedAt + PENDING_BIND_TTL_MS) / 1000);

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('Bind workspace?')
    .setDescription(`This will bind this channel to ${formatCode(preview.workspace.name)}.`)
    .addFields(
      { name: 'Provider', value: formatCode(preview.workspace.provider), inline: true },
      { name: 'Channel', value: formatCode(`#${preview.channelName}`), inline: true },
      { name: 'Workspace', value: formatCode(preview.workspace.name), inline: true },
      { name: 'Working dir', value: formatCode(preview.workspace.cwd), inline: false },
      { name: 'Config', value: formatCode(relativeConfigPath(preview.configPath)), inline: false },
      { name: 'Expires', value: `<t:${expiresAt}:R>`, inline: true },
    );

  if (auditWarnings.length > 0) {
    embed.addFields({
      name: 'Audit warnings',
      value: formatAuditWarnings(auditWarnings),
      inline: false,
    });
  }

  return embed;
}

function buildSuccessEmbed(result: {
  backupPath: string;
  workspace: { name: string; cwd: string; provider: Provider };
  configPath: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('Workspace bound')
    .setDescription(`${formatCode(result.workspace.name)} is ready in this channel.`)
    .addFields(
      { name: 'Provider', value: formatCode(result.workspace.provider), inline: true },
      { name: 'Workspace', value: formatCode(result.workspace.name), inline: true },
      { name: 'Working dir', value: formatCode(result.workspace.cwd), inline: false },
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

function formatAuditWarnings(warnings: AuditFinding[]): string {
  const lines = warnings.slice(0, 5).map((warning) => {
    const prefix = warning.severity === 'critical' ? '❌' : '⚠️';
    return warning.detail === undefined
      ? `${prefix} ${warning.title}`
      : `${prefix} ${warning.title}\n${warning.detail}`;
  });
  const remaining = warnings.length - lines.length;
  const value = remaining > 0 ? [...lines, `+${remaining} more warning(s)`].join('\n') : lines.join('\n');

  return value.length > 1024 ? `${value.slice(0, 1021)}...` : value;
}

function buildActionRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLY_PREFIX}${id}`)
      .setLabel('Apply')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CANCEL_PREFIX}${id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

function getPending(interactionUserId: string, channelId: string, id: string): PendingBind {
  deleteExpiredPendingBinds();

  const pending = pendingBinds.get(id);
  if (pending === undefined) {
    throw new Error('This bind request expired. Run /bind again.');
  }

  if (pending.userId !== interactionUserId) {
    throw new Error('Only the user who started this bind request can use these buttons.');
  }

  if (pending.channelId !== channelId) {
    throw new Error('This bind request belongs to a different channel.');
  }

  return pending;
}

export const bindCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('bind')
    .setDescription('Bind this channel to a local workspace')
    .addStringOption((option) =>
      option
        .setName('provider')
        .setDescription('Agent provider for this workspace')
        .addChoices(
          { name: 'Codex', value: 'codex' },
          { name: 'Claude', value: 'claude' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('dev_root')
        .setDescription(`Workspace parent directory. Defaults to ${DEFAULT_BIND_DEV_ROOT}`),
    )
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Workspace name. Defaults to the channel name'),
    )
    .addStringOption((option) =>
      option
        .setName('cwd')
        .setDescription('Workspace directory. Must be inside dev_root'),
    )
    .toJSON(),

  async execute(interaction, { cfg, configPath }) {
    deleteExpiredPendingBinds();

    if (interaction.guildId !== cfg.discord.guild_id) {
      await interaction.reply({
        content: '❌ This command can only run in the configured Discord server.',
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.channel;
    if (channel === null || channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: '❌ Run /bind from a server text channel.',
        ephemeral: true,
      });
      return;
    }

    const providerValue = interaction.options.getString('provider') ?? DEFAULT_BIND_PROVIDER;
    if (!isProvider(providerValue)) {
      await interaction.reply({
        content: '❌ Unknown provider.',
        ephemeral: true,
      });
      return;
    }

    const provider = providerValue;
    const devRoot = interaction.options.getString('dev_root') ?? undefined;
    const name = interaction.options.getString('name') ?? undefined;
    const cwd = interaction.options.getString('cwd') ?? undefined;
    const id = createPendingId();
    const pending: PendingBind = {
      id,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      requestedAt: Date.now(),
      request: {
        channelId: interaction.channelId,
        channelName: channel.name,
        provider,
        devRoot,
        name,
        cwd,
        configPath,
      },
    };

    try {
      const preview = await previewWorkspaceBinding({ cfg, ...pending.request });
      const auditWarnings =
        interaction.guild === null
          ? []
          : auditBindPreview({
              cfg,
              guild: interaction.guild,
              channel: channel as TextChannel,
              workspace: preview.workspace,
            });
      pendingBinds.set(id, pending);

      await interaction.reply({
        embeds: [buildPreviewEmbed(pending, preview, auditWarnings)],
        components: [buildActionRow(id)],
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Bind preview failed', error)],
        ephemeral: true,
      });
    }
  },
};

const applyHandler: ButtonHandler = {
  customIdPrefix: APPLY_PREFIX,

  async handle(interaction, { reloadConfig }) {
    const id = interaction.customId.slice(APPLY_PREFIX.length);

    try {
      const pending = getPending(interaction.user.id, interaction.channelId, id);
      const cfg = await loadConfig(pending.request.configPath);
      const preview = await previewWorkspaceBinding({ cfg, ...pending.request });
      const result = await applyWorkspaceBinding(preview);

      pendingBinds.delete(id);

      try {
        await reloadConfig();
      } catch (error) {
        await interaction.update({
          embeds: [
            buildSuccessEmbed(result)
              .setColor(0xf59e0b)
              .setTitle('Workspace bound, reload failed')
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
        embeds: [buildErrorEmbed('Bind failed', error)],
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
      pendingBinds.delete(id);

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x6b7280)
            .setTitle('Bind cancelled'),
        ],
        components: [],
      });
    } catch (error) {
      await interaction.update({
        embeds: [buildErrorEmbed('Bind cancelled', error)],
        components: [],
      });
    }
  },
};

export const buttonHandlers: ButtonHandler[] = [applyHandler, cancelHandler];
