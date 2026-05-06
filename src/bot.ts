import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  type ButtonInteraction,
  type Interaction,
  type Message,
} from 'discord.js';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ATTACHMENTS_DIR,
  downloadAttachments,
  DISCORD_FILE_LIMIT,
  formatPromptWithAttachments,
  type DownloadedAttachment,
} from './attachments.js';
import { isAllowed } from './allowlist.js';
import { slashCommands, findCommandByName, findButtonHandler } from './commands/index.js';
import { loadConfig, getWorkspaceByChannel, getWorkspaceByName, type Config, type Provider } from './config.js';
import { acquireLock } from './lock.js';
import {
  cleanupAttachmentOutbox,
  createAttachmentOutbox,
  readAttachmentOutbox,
} from './outbound-attachments.js';
import { getProviderUsageSnapshot } from './provider-usage.js';
import {
  DISCORD_BRIDGE_HOOK_CLI_ENV,
  DISCORD_BRIDGE_HOOK_MAX_DAYS_ENV,
  DISCORD_BRIDGE_HOOK_MAX_PER_WORKSPACE_ENV,
  DISCORD_BRIDGE_HOOKS_FILE_ENV,
  hookAgentInstructions,
  ScheduledHookScheduler,
} from './scheduled-hooks.js';
import { SessionManager, type WorkspaceStatus } from './session/manager.js';
import type { ClaudeEvent } from './session/parser.js';
import {
  createDiscordStreamer,
  type DiscordStreamer,
  type SendableChannel,
  type StreamHandle,
} from './stream.js';
import {
  createLocalVoiceTranscriber,
  createVoiceTranscriber,
  excludeAudioAttachments,
  formatVoicePrompt,
  startVoiceTranscriptionServer,
  transcribeVoiceAttachments,
  type VoiceTranscriber,
  type VoiceTranscriptionServer,
} from './voice.js';
import { DEFAULT_BIND_CONFIG_PATH } from './workspace-binding.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const PERMISSION_ALLOW_CUSTOM_ID_PREFIX = 'permission-allow:';
const PERMISSION_DENY_CUSTOM_ID_PREFIX = 'permission-deny:';
const PERMISSION_DECISION_TRIGGER = '.';
const PERMISSION_APPROVED_PROMPT = [
  'The visible prompt is only a transport trigger; do not repeat or mention it.',
  'The Discord user approved the previous permission request.',
  'Retry the previously blocked operation once.',
  'If the tool or runtime still blocks it, do not loop or ask again; explain the blocker and continue with a safe fallback.',
  'If there is no previous blocked operation in context, briefly acknowledge in Korean that the approval was recorded and no action is pending.',
].join('\n');
const PERMISSION_DENIED_PROMPT = [
  'The visible prompt is only a transport trigger; do not repeat or mention it.',
  'The Discord user denied the previous permission request.',
  'Do not retry the same privileged operation or ask for that approval again.',
  'Continue with the safest available alternative that avoids the denied permission.',
  'If the goal cannot be completed without it, explain the blocker and provide exact manual steps or write files to a safe temporary path.',
  'If there is no previous blocked operation in context, briefly acknowledge in Korean that the denial was recorded and no action is pending.',
].join('\n');

type ConfigReloadSummary = { added: string[]; removed: string[]; changed: string[] };
type PermissionAction = 'allow' | 'deny';
type PermissionActionRequest = {
  action: PermissionAction;
  workspace: string;
  requestId?: string;
};
type VoiceRuntime = {
  transcriber: VoiceTranscriber | undefined;
  server: VoiceTranscriptionServer | undefined;
};

function defaultStatePath(): string {
  return path.join(os.homedir(), 'Library/Application Support/discord-bridge/state.json');
}

function resolveHooksFilePath(cfg: Config, statePath: string): string {
  return cfg.hooks.file ?? path.join(path.dirname(statePath), 'hooks.json');
}

function hookCliPath(): string {
  return path.resolve('scripts/discord-hook');
}

function hookAgentEnv(cfg: Config, hooksFilePath: string): NodeJS.ProcessEnv {
  if (!cfg.hooks.enabled) {
    return {};
  }

  return {
    [DISCORD_BRIDGE_HOOKS_FILE_ENV]: hooksFilePath,
    [DISCORD_BRIDGE_HOOK_CLI_ENV]: hookCliPath(),
    [DISCORD_BRIDGE_HOOK_MAX_DAYS_ENV]: String(cfg.hooks.max_schedule_days),
    [DISCORD_BRIDGE_HOOK_MAX_PER_WORKSPACE_ENV]: String(cfg.hooks.max_hooks_per_workspace),
  };
}

function hookHiddenInstructions(cfg: Config): string | undefined {
  return cfg.hooks.enabled ? hookAgentInstructions() : undefined;
}

async function replyEphemeral(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (error) {
    console.error(error);
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatCost(costUsd: number | undefined): string | null {
  return costUsd === undefined ? null : `$${costUsd.toFixed(4)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`;
}

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) {
    return `${Math.round(contextWindow / 1_000_000)}M`;
  }

  if (contextWindow >= 1000) {
    return `${Math.round(contextWindow / 1000)}K`;
  }

  return `${contextWindow}`;
}

function formatContext(
  contextTokens: number,
  contextWindow: number | undefined,
  modelId?: string,
): string {
  if (contextWindow === undefined || contextWindow <= 0) {
    return 'ctx n/a';
  }

  const percent = (contextTokens / contextWindow) * 100;
  const modelPart = modelId !== undefined ? ` · ${modelId.replace(/^claude-/, '')}` : '';
  return `ctx ${percent.toFixed(1)}% (${formatTokenCount(contextTokens)}/${formatContextWindow(contextWindow)}${modelPart})`;
}

function formatUsagePercent(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function formatTimeUntil(target: Date | null): string | null {
  if (target === null) {
    return null;
  }

  const ms = target.getTime() - Date.now();
  if (ms <= 0) {
    return '0m';
  }

  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) {
    return `${days}d${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h${mins}m`;
  }

  return `${mins}m`;
}

async function buildResultSummary(
  provider: Provider,
  event: Extract<ClaudeEvent, { type: 'result' }>,
): Promise<string> {
  const usage = await getProviderUsageSnapshot(provider);
  const contextTokens =
    provider === 'codex' && usage.lastContextTokens !== undefined
      ? usage.lastContextTokens
      : event.contextTokens;
  const contextWindow =
    provider === 'codex' && usage.modelContextWindow !== undefined
      ? usage.modelContextWindow
      : event.contextWindow;
  const turnTokens =
    provider === 'codex' && usage.lastTurnTokens !== undefined
      ? usage.lastTurnTokens
      : event.tokens;
  const context = formatContext(contextTokens, contextWindow, event.modelId);
  const fiveHour = formatUsagePercent(usage.fiveHourUsedPercent);
  const sevenDay = formatUsagePercent(usage.sevenDayUsedPercent);
  const fiveHourLeft = formatTimeUntil(usage.fiveHourResetAt);
  const sevenDayLeft = formatTimeUntil(usage.sevenDayResetAt);
  const parts = [formatDuration(event.durationMs), `${formatTokenCount(turnTokens)} tokens`];
  const cost = formatCost(event.costUsd);

  if (cost !== null) {
    parts.push(cost);
  }

  parts.push(context, `5h ${fiveHour}`);
  if (fiveHourLeft !== null) {
    parts.push(`${fiveHourLeft} left`);
  }

  parts.push(`7d ${sevenDay}`);
  if (sevenDayLeft !== null) {
    parts.push(`${sevenDayLeft} left`);
  }

  return parts.join(' · ');
}

function warnIgnoredReloadChange(field: string): void {
  console.warn(`[config-reload] ${field} changed; restart the bot to apply it.`);
}

function permissionActionCustomId(
  action: PermissionAction,
  workspace: string,
  requestId?: string,
): string {
  const prefix =
    action === 'allow' ? PERMISSION_ALLOW_CUSTOM_ID_PREFIX : PERMISSION_DENY_CUSTOM_ID_PREFIX;
  const workspacePart = encodeURIComponent(workspace);
  const requestPart = requestId !== undefined ? `:${encodeURIComponent(requestId)}` : '';
  return `${prefix}${workspacePart}${requestPart}`;
}

function permissionActionFromCustomId(customId: string): PermissionActionRequest | undefined {
  const action = customId.startsWith(PERMISSION_ALLOW_CUSTOM_ID_PREFIX)
    ? 'allow'
    : customId.startsWith(PERMISSION_DENY_CUSTOM_ID_PREFIX)
      ? 'deny'
      : undefined;
  if (action === undefined) {
    return undefined;
  }

  const prefix =
    action === 'allow' ? PERMISSION_ALLOW_CUSTOM_ID_PREFIX : PERMISSION_DENY_CUSTOM_ID_PREFIX;

  try {
    const [workspacePart, requestIdPart] = customId.slice(prefix.length).split(':', 2);
    return {
      action,
      workspace: decodeURIComponent(workspacePart),
      ...(requestIdPart !== undefined ? { requestId: decodeURIComponent(requestIdPart) } : {}),
    };
  } catch {
    return undefined;
  }
}

function permissionActionComponents(
  workspace: string,
  requestId?: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(permissionActionCustomId('allow', workspace, requestId))
        .setLabel(requestId === undefined ? 'Allow and retry' : 'Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(permissionActionCustomId('deny', workspace, requestId))
        .setLabel(requestId === undefined ? 'Deny and continue' : 'Deny')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function preserveRuntimeReloadFields(current: Config, next: Config): Config {
  if (current.discord.bot_token !== next.discord.bot_token) {
    warnIgnoredReloadChange('discord.bot_token');
  }

  if (current.discord.guild_id !== next.discord.guild_id) {
    warnIgnoredReloadChange('discord.guild_id');
  }

  if (current.state_file !== next.state_file) {
    warnIgnoredReloadChange('state_file');
  }

  return {
    ...next,
    state_file: current.state_file,
    discord: {
      ...next.discord,
      bot_token: current.discord.bot_token,
      guild_id: current.discord.guild_id,
    },
  };
}

function formatReloadSummary(summary: ConfigReloadSummary): string {
  return `added=${summary.added.length}, removed=${summary.removed.length}, changed=${summary.changed.length}`;
}

function relativeTimestamp(value: Date | number | string): string {
  const unix = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${unix}:R>`;
}

function shortSessionId(sessionId: string | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : 'none';
}

function formatResumeDescription(status: WorkspaceStatus): string {
  const parts = [
    `provider: \`${status.provider}\``,
    `session: \`${shortSessionId(status.sessionId)}\``,
    `messages: \`${status.messageCount}\``,
  ];

  if (status.lastPromptAt) {
    parts.push(`last prompt: ${relativeTimestamp(status.lastPromptAt)}`);
  }

  return parts.join(' · ');
}

function formatDiscordApiError(error: unknown): string | undefined {
  if (!(error instanceof DiscordAPIError)) {
    return undefined;
  }

  switch (error.code) {
    case 10003:
      return 'unknown channel';
    case 50001:
      return 'missing access';
    case 50013:
      return 'missing permissions';
    default:
      return `${error.code}: ${error.message}`;
  }
}

function canSendToChannel(
  channel: { permissionsFor?: (...args: any[]) => { has: (perm: bigint) => boolean } | null } & SendableChannel,
  member: unknown,
): boolean {
  if (typeof channel.permissionsFor !== 'function') {
    return true;
  }

  const permissions = channel.permissionsFor(member);
  if (!permissions) {
    return false;
  }

  return permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.SendMessages);
}

async function sendRestoredSessionNotices(
  client: Client<true>,
  cfg: Config,
  sessions: SessionManager,
): Promise<void> {
  const restored = sessions
    .listAll()
    .filter(
      (status) =>
        status.restoredFromDisk &&
        (status.sessionId !== undefined || status.interruptedTurnPending),
    );

  for (const status of restored) {
    const workspace = getWorkspaceByName(cfg, status.workspace);
    if (!workspace) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(workspace.channel_id);
      if (!channel?.isSendable()) {
        continue;
      }

      if (!canSendToChannel(channel, client.user)) {
        console.warn(
          `[restore-notify] skipping workspace=${status.workspace} channel=${workspace.channel_id}: missing permissions`,
        );
        continue;
      }

      sessions.hydrateQueueContext(status.workspace, {
        workspace: status.workspace,
        channel,
      });

      const embed = new EmbedBuilder()
        .setTitle('♻️ Session restored')
        .setDescription(formatResumeDescription(status))
        .setColor(0x0ea5e9)
        .addFields({
          name: 'What this means',
          value: status.interruptedTurnPending
            ? 'An in-flight turn was interrupted by restart. The bot will resume it automatically from the current workspace state.'
            : 'Session metadata was restored. Send a new message to continue.',
          inline: false,
        });

      if (status.lastPromptPreview) {
        embed.addFields({
          name: 'Last prompt preview',
          value:
            status.lastPromptPreview.length > 1000
              ? `${status.lastPromptPreview.slice(0, 997)}...`
              : status.lastPromptPreview,
          inline: false,
        });
      }

      await channel.send({ embeds: [embed] });
    } catch (error) {
      const summary = formatDiscordApiError(error);
      if (summary !== undefined) {
        console.warn(
          `[restore-notify] skipping workspace=${status.workspace} channel=${workspace.channel_id}: ${summary}`,
        );
        continue;
      }

      console.error('[restore-notify]', error);
    }
  }
}

async function resumeInterruptedTurns(
  client: Client<true>,
  cfg: Config,
  sessions: SessionManager,
  streamer: DiscordStreamer,
): Promise<void> {
  const interrupted = sessions
    .listAll()
    .filter((status) => status.restoredFromDisk && status.interruptedTurnPending);

  for (const status of interrupted) {
    const workspace = getWorkspaceByName(cfg, status.workspace);
    const originalPrompt = sessions.interruptedTurnPrompt(status.workspace);
    if (!workspace || !originalPrompt) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(workspace.channel_id);
      if (!channel?.isSendable()) {
        continue;
      }

      if (!canSendToChannel(channel, client.user)) {
        console.warn(
          `[auto-resume] skipping workspace=${status.workspace} channel=${workspace.channel_id}: missing permissions`,
        );
        continue;
      }

      await channel.send(
        '🔄 interrupted turn detected after restart; resuming automatically from current workspace state.',
      );

      await runWithAttachmentOutbox(async (outboxDir) => {
        const events = sessions.sendPrompt(
          workspace.name,
          originalPrompt,
          {
            attachmentOutboxDir: outboxDir,
            persistedPrompt: originalPrompt,
            recoveryMode: true,
          },
        );
        await handleSessionEvents(
          workspace.name,
          channel,
          events,
          streamer,
          status.provider,
          undefined,
          outboxDir,
        );
      });
    } catch (error) {
      const summary = formatDiscordApiError(error);
      if (summary !== undefined) {
        console.warn(
          `[auto-resume] skipping workspace=${status.workspace} channel=${workspace.channel_id}: ${summary}`,
        );
        continue;
      }

      console.error('[auto-resume]', error);
    }
  }
}

async function resumeRestoredQueues(
  client: Client<true>,
  cfg: Config,
  sessions: SessionManager,
): Promise<void> {
  const queued = sessions
    .listAll()
    .filter((status) => status.restoredFromDisk && !status.interruptedTurnPending && status.queuedCount > 0);

  for (const status of queued) {
    const workspace = getWorkspaceByName(cfg, status.workspace);
    if (!workspace) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(workspace.channel_id);
      if (!channel?.isSendable()) {
        continue;
      }

      if (!canSendToChannel(channel, client.user)) {
        console.warn(
          `[restore-queue] skipping workspace=${status.workspace} channel=${workspace.channel_id}: missing permissions`,
        );
        continue;
      }

      sessions.hydrateQueueContext(status.workspace, {
        workspace: status.workspace,
        channel,
      });
      sessions.resumePendingQueue(status.workspace);
    } catch (error) {
      const summary = formatDiscordApiError(error);
      if (summary !== undefined) {
        console.warn(
          `[restore-queue] skipping workspace=${status.workspace} channel=${workspace.channel_id}: ${summary}`,
        );
        continue;
      }

      console.error('[restore-queue]', error);
    }
  }
}

async function sendQueuedNotice(
  channel: SendableChannel,
  buffered: number,
  userMessage?: Message<boolean>,
): Promise<void> {
  const content =
    buffered <= 1
      ? '⏸ current turn is still running; I captured this and will send it on the next turn.'
      : `⏸ added to the next turn; ${buffered} queued messages will be delivered together.`;

  try {
    if (userMessage !== undefined) {
      await userMessage.reply({
        content,
        allowedMentions: { repliedUser: true },
      });
      return;
    }

    await channel.send(content);
  } catch (error) {
    console.error(error);
  }
}

async function uploadFiles(channel: SendableChannel, filePaths: string[]): Promise<void> {
  for (const filePath of [...new Set(filePaths)]) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > DISCORD_FILE_LIMIT) {
        continue;
      }

      const buffer = await readFile(filePath);
      const attachment = new AttachmentBuilder(buffer, { name: path.basename(filePath) });
      await channel.send({ files: [attachment] });
    } catch {
      // File may have been deleted or moved during the turn.
    }
  }
}

function isInboundAttachmentPath(filePath: string): boolean {
  return filePath.split(path.sep).join('/').includes(`/${ATTACHMENTS_DIR}/`);
}

function shouldAutoUploadImage(event: Extract<ClaudeEvent, { type: 'tool_use' }>): boolean {
  if (event.filePath === undefined) {
    return false;
  }

  if (!IMAGE_EXTENSIONS.has(path.extname(event.filePath).toLowerCase())) {
    return false;
  }

  if (event.tool === 'Write') {
    return true;
  }

  if (event.tool === 'Read') {
    return !isInboundAttachmentPath(event.filePath);
  }

  return false;
}

async function runWithAttachmentOutbox(
  run: (outboxDir: string) => Promise<void>,
): Promise<void> {
  const outboxDir = await createAttachmentOutbox();
  try {
    await run(outboxDir);
  } finally {
    await cleanupAttachmentOutbox(outboxDir);
  }
}

async function createVoiceRuntime(cfg: Config): Promise<VoiceRuntime> {
  const transcriber = createVoiceTranscriber(cfg.voice);
  const serverTranscriber =
    cfg.voice.server.enabled && cfg.voice.provider === 'local' && transcriber !== undefined
      ? transcriber
      : cfg.voice.server.enabled
        ? createLocalVoiceTranscriber(cfg.voice)
        : undefined;
  const server = await startVoiceTranscriptionServer(cfg.voice, serverTranscriber);

  return { transcriber, server };
}

async function closeVoiceRuntime(runtime: VoiceRuntime): Promise<void> {
  if (runtime.server === undefined) {
    return;
  }

  try {
    await runtime.server.close();
  } catch (error) {
    console.error('[voice] failed to close transcription server:', error);
  }
}

async function handleSessionEvents(
  workspace: string,
  channel: SendableChannel,
  events: AsyncGenerator<ClaudeEvent>,
  streamer: DiscordStreamer,
  provider: Provider,
  userMessage?: Message<boolean>,
  attachmentOutboxDir?: string,
): Promise<void> {
  let handle: StreamHandle | undefined;
  let resultEvent: Extract<ClaudeEvent, { type: 'result' }> | undefined;
  let errorSummary: string | undefined;
  let permissionSummary: string | undefined;
  const imageFilesToUpload: string[] = [];

  const getHandle = async (): Promise<StreamHandle> => {
    handle ??= await streamer.begin(channel, undefined);
    return handle;
  };

  try {
    for await (const event of events) {
      if (event.type === 'queued') {
        await sendQueuedNotice(channel, event.buffered, userMessage);
        continue;
      }

      if (event.type === 'permission_block') {
        try {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('🚫 permission blocked')
                .setDescription(`${event.tool}: ${event.reason}`)
                .setFooter({ text: 'Allow retries once; deny continues with a safer alternative.' })
                .setColor(0xef4444),
            ],
            components: permissionActionComponents(workspace),
          });
        } catch (error) {
          console.error(error);
        }
        continue;
      }

      if (event.type === 'permission_request') {
        permissionSummary = `⏸️ waiting for approval · ${event.tool} ${event.target}`.trimEnd();
        try {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('🛂 permission requested')
                .setDescription(`\`${event.tool}\` ${event.target}`)
                .setFooter({ text: 'Approve to resume the paused tool call; deny to continue safely.' })
                .setColor(0xf59e0b),
            ],
            components: permissionActionComponents(workspace, event.id),
          });
        } catch (error) {
          console.error(error);
        }
        continue;
      }

      if (event.type === 'result') {
        resultEvent = event;
        continue;
      }

      if (event.type === 'session_init') {
        if (provider === 'codex') {
          await getHandle();
        }
        continue;
      }

      const currentHandle = await getHandle();

      switch (event.type) {
        case 'text_delta':
          currentHandle.append(event.text);
          break;

        case 'tool_use': {
          if (event.tool === 'Agent') {
            currentHandle.append('\n🤖 agent summoned\n');
            break;
          }

          let line = `\n🔧 \`${event.tool}\` ${event.target}`;
          if (event.diff !== undefined) {
            line += `\n\`\`\`diff\n${event.diff}\n\`\`\``;
          }
          line += '\n';
          currentHandle.append(line);

          if (shouldAutoUploadImage(event) && event.filePath !== undefined) {
            imageFilesToUpload.push(event.filePath);
          }
          break;
        }

        case 'error':
          if (event.fatal) {
            errorSummary = event.message;
            await currentHandle.failWith({
              title: '❌ error',
              description: event.message,
              color: 0xef4444,
            });
            return;
          }

          currentHandle.append(`\n⚠️ ${event.message}\n`);
          break;
      }
    }
  } catch (error) {
    console.error(error);
    errorSummary = error instanceof Error ? error.message : String(error);
    const currentHandle = await getHandle();
    await currentHandle.failWith({
      title: '❌ error',
      description: errorSummary,
      color: 0xef4444,
    });
  } finally {
    if (handle !== undefined) {
      await handle.finish();
    }

    if (imageFilesToUpload.length > 0) {
      await uploadFiles(channel, imageFilesToUpload);
    }

    if (attachmentOutboxDir !== undefined) {
      const outboxFiles = await readAttachmentOutbox(attachmentOutboxDir);
      if (outboxFiles.length > 0) {
        await uploadFiles(channel, outboxFiles);
      }
    }

    const replyLine =
      errorSummary !== undefined
        ? `❌ error · ${errorSummary}`
        : permissionSummary !== undefined && resultEvent?.deferred === true
          ? permissionSummary
          : resultEvent !== undefined
          ? `✅ done · ${await buildResultSummary(provider, resultEvent)}`
          : undefined;

    if (userMessage !== undefined && replyLine !== undefined) {
      try {
        await userMessage.reply({
          content: replyLine,
          allowedMentions: { repliedUser: true },
        });
      } catch (error) {
        console.error(error);
      }
    } else if (replyLine !== undefined) {
      try {
        await channel.send(replyLine);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

async function handlePermissionActionInteraction(
  interaction: ButtonInteraction,
  sessions: SessionManager,
  streamer: DiscordStreamer,
): Promise<boolean> {
  const permissionAction = permissionActionFromCustomId(interaction.customId);
  if (permissionAction === undefined) {
    return false;
  }
  const { action, workspace, requestId } = permissionAction;

  if (!interaction.channel?.isSendable()) {
    await replyEphemeral(interaction, '❌ This channel cannot receive session output.');
    return true;
  }

  const channel = interaction.channel;
  const actionLabel = action === 'allow' ? 'Allowed' : 'Denied';
  const embeds = interaction.message.embeds.map((embed) =>
    EmbedBuilder.from(embed)
      .setColor(action === 'allow' ? 0x22c55e : 0x6b7280)
      .setFooter({ text: `${actionLabel} by ${interaction.user.tag}` }),
  );

  await interaction.update({ embeds, components: [] });

  await runWithAttachmentOutbox(async (outboxDir) => {
    const provider = sessions.status(workspace).provider;
    const events =
      requestId !== undefined
        ? sessions.resolvePermission(workspace, requestId, action, {
            attachmentOutboxDir: outboxDir,
          })
        : sessions.sendPrompt(
            workspace,
            PERMISSION_DECISION_TRIGGER,
            {
              attachmentOutboxDir: outboxDir,
              hiddenInstructions:
                action === 'allow' ? PERMISSION_APPROVED_PROMPT : PERMISSION_DENIED_PROMPT,
              internalMode: true,
            },
            { workspace, channel },
          );

    await handleSessionEvents(
      workspace,
      channel,
      events,
      streamer,
      provider,
      undefined,
      outboxDir,
    );
  });

  return true;
}

async function main(): Promise<void> {
  const configPath = DEFAULT_BIND_CONFIG_PATH;
  let currentConfig = await loadConfig(configPath);
  const statePath = currentConfig.state_file ?? defaultStatePath();
  let hooksFilePath = resolveHooksFilePath(currentConfig, statePath);
  const lockPath = path.join(path.dirname(statePath), 'bot.pid');
  let releaseLock: () => Promise<void>;

  try {
    releaseLock = await acquireLock(lockPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const sessions = new SessionManager(
    currentConfig,
    statePath,
    hookAgentEnv(currentConfig, hooksFilePath),
    hookHiddenInstructions(currentConfig),
  );
  await sessions.loadPersisted(statePath);
  const streamer = createDiscordStreamer();
  let voiceRuntime = await createVoiceRuntime(currentConfig);
  let hookScheduler: ScheduledHookScheduler | undefined;
  sessions.setQueueRunner(async (ctx, run) => {
    if (ctx === undefined) {
      console.error('queueRunner invoked without queue context');
      return;
    }

    await runWithAttachmentOutbox(async (outboxDir) => {
      const provider = sessions.status(ctx.workspace).provider;
      await handleSessionEvents(
        ctx.workspace,
        ctx.channel,
        run({ attachmentOutboxDir: outboxDir }),
        streamer,
        provider,
        ctx.userMessage,
        outboxDir,
      );
    });
  });

  const reloadConfig = async (): Promise<ConfigReloadSummary> => {
    const nextConfig = await loadConfig(configPath);
    const runtimeConfig = preserveRuntimeReloadFields(currentConfig, nextConfig);
    const previousVoiceRuntime = voiceRuntime;
    await closeVoiceRuntime(previousVoiceRuntime);

    try {
      voiceRuntime = await createVoiceRuntime(runtimeConfig);
    } catch (error) {
      try {
        voiceRuntime = await createVoiceRuntime(currentConfig);
      } catch (restoreError) {
        console.error('[voice] failed to restore previous voice runtime:', restoreError);
        voiceRuntime = { transcriber: undefined, server: undefined };
      }

      throw error;
    }

    currentConfig = runtimeConfig;
    hooksFilePath = resolveHooksFilePath(runtimeConfig, statePath);
    sessions.setBridgeRuntime(
      hookAgentEnv(runtimeConfig, hooksFilePath),
      hookHiddenInstructions(runtimeConfig),
    );
    hookScheduler?.update({ cfg: runtimeConfig, hooksFilePath });
    return sessions.updateConfig(runtimeConfig);
  };

  const deps = {
    get cfg() {
      return currentConfig;
    },
    configPath,
    get hooksFilePath() {
      return hooksFilePath;
    },
    sessions,
    streamer,
    reloadConfig,
  };
  const token = currentConfig.discord.bot_token;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    hookScheduler = new ScheduledHookScheduler({
      client: readyClient,
      cfg: currentConfig,
      hooksFilePath,
    });
    hookScheduler.start();

    try {
      await readyClient.application.fetch();
      const applicationId = readyClient.application.id;
      const rest = new REST({ version: '10' }).setToken(token);

      await rest.put(Routes.applicationGuildCommands(applicationId, currentConfig.discord.guild_id), {
        body: slashCommands.map((command) => command.data),
      });

      const notifyChannelName = currentConfig.discord.notify_channel_name;
      const notifyEmbed = new EmbedBuilder()
        .setTitle('🟢 Bot started')
        .setDescription(`host: \`${os.hostname()}\` · pid: \`${process.pid}\` · ${new Date().toISOString()}`)
        .setColor(0x22c55e);

      for (const guild of readyClient.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          if (channel.name !== notifyChannelName) {
            continue;
          }

          if (!channel.isSendable()) {
            continue;
          }

          if (!canSendToChannel(channel, readyClient.user)) {
            continue;
          }

          try {
            await channel.send({ embeds: [notifyEmbed] });
          } catch (error) {
            const summary = formatDiscordApiError(error);
            if (summary !== undefined) {
              console.warn(`[startup-notify] skipped channel=${channel.id}: ${summary}`);
              continue;
            }

            console.error('[startup-notify]', error);
          }
        }
      }

      await sendRestoredSessionNotices(readyClient, currentConfig, sessions);
      await resumeInterruptedTurns(readyClient, currentConfig, sessions, streamer);
      await resumeRestoredQueues(readyClient, currentConfig, sessions);
    } catch (error) {
      console.error(error);
    }

    console.log(`discord-bridge online as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.user.bot) {
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (!isAllowed(interaction.user.id, currentConfig)) {
        await replyEphemeral(interaction, '❌ Not authorized.');
        return;
      }

      const cmd = findCommandByName(interaction.commandName);

      if (!cmd) {
        await replyEphemeral(interaction, 'Unknown command.');
        return;
      }

      try {
        await cmd.execute(interaction, deps);
      } catch (error) {
        console.error(error);
        await replyEphemeral(interaction, '❌ Error while running command.');
      }

      return;
    }

    if (interaction.isButton()) {
      if (!isAllowed(interaction.user.id, currentConfig)) {
        await replyEphemeral(interaction, '❌ Not authorized.');
        return;
      }

      try {
        if (await handlePermissionActionInteraction(interaction, sessions, streamer)) {
          return;
        }

        const handler = findButtonHandler(interaction.customId);

        if (!handler) {
          return;
        }

        await handler.handle(interaction, deps);
      } catch (error) {
        console.error(error);
        await replyEphemeral(interaction, '❌ Error while handling button.');
      }
    }
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guildId) {
      return;
    }

    if (!isAllowed(msg.author.id, currentConfig)) {
      return;
    }

    const workspace = getWorkspaceByChannel(currentConfig, msg.channelId);

    if (!workspace) {
      return;
    }

    const text = msg.content.trim();

    if (!text && msg.attachments.size === 0) {
      return;
    }

    if (!msg.channel.isSendable()) {
      console.error(`Channel ${msg.channelId} cannot send messages.`);
      return;
    }

    let downloaded: DownloadedAttachment[] = [];
    if (msg.attachments.size > 0) {
      try {
        downloaded = await downloadAttachments(msg.attachments, workspace.cwd, msg.id);
      } catch (err) {
        console.error('[attachments] download failed:', err);
      }
    }

    const voiceResult = await transcribeVoiceAttachments(
      currentConfig.voice,
      voiceRuntime.transcriber,
      downloaded,
    );
    for (const failure of voiceResult.failures) {
      console.warn(
        `[voice] failed to transcribe ${failure.attachment.originalName}: ${failure.error}`,
      );
    }

    const promptText = currentConfig.voice.enabled
      ? formatVoicePrompt(text, voiceResult)
      : text;
    const promptAttachments = currentConfig.voice.enabled
      ? excludeAudioAttachments(downloaded, voiceResult)
      : downloaded;

    if (
      currentConfig.voice.enabled &&
      promptText.length > 0 &&
      promptAttachments.length === 0 &&
      voiceResult.transcripts.length === 0 &&
      voiceResult.failures.length > 0 &&
      text.length === 0
    ) {
      await msg.reply({
        content: `❌ voice transcription failed: ${voiceResult.failures[0]?.error ?? 'unknown error'}`,
        allowedMentions: { repliedUser: true },
      });
      return;
    }

    const prompt = formatPromptWithAttachments(promptText, promptAttachments);

    if (!prompt) {
      return;
    }

    await runWithAttachmentOutbox(async (outboxDir) => {
      const events = sessions.sendPrompt(
        workspace.name,
        prompt,
        { attachmentOutboxDir: outboxDir },
        {
          workspace: workspace.name,
          channel: msg.channel,
          userMessage: msg as Message<boolean>,
        },
      );
      await handleSessionEvents(
        workspace.name,
        msg.channel,
        events,
        streamer,
        sessions.status(workspace.name).provider,
        msg as Message<boolean>,
        outboxDir,
      );
    });
  });

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);

    void (async () => {
      client.destroy();
      hookScheduler?.stop();
      await closeVoiceRuntime(voiceRuntime);
      await releaseLock();
      process.exit(0);
    })();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', () => {
    console.log('Received SIGHUP; reloading config.');
    void reloadConfig()
      .then((summary) => {
        console.log(`[config-reload] reloaded: ${formatReloadSummary(summary)}`);
      })
      .catch((error) => {
        console.error('[config-reload] reload failed:', error);
      });
  });
  process.on('unhandledRejection', (err) => console.error(err));
  process.on('uncaughtException', (err) => {
    console.error(err);
    process.exit(1);
  });

  await client.login(token);
}

void main();
