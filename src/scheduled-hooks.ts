import {
  Client,
  EmbedBuilder,
  type SendableChannels,
} from 'discord.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from './config.js';

export const DISCORD_BRIDGE_HOOKS_FILE_ENV = 'DISCORD_BRIDGE_HOOKS_FILE';
export const DISCORD_BRIDGE_HOOK_WORKSPACE_ENV = 'DISCORD_BRIDGE_HOOK_WORKSPACE';
export const DISCORD_BRIDGE_HOOK_CLI_ENV = 'DISCORD_BRIDGE_HOOK_CLI';
export const DISCORD_BRIDGE_HOOK_MAX_DAYS_ENV = 'DISCORD_BRIDGE_HOOK_MAX_SCHEDULE_DAYS';
export const DISCORD_BRIDGE_HOOK_MAX_PER_WORKSPACE_ENV =
  'DISCORD_BRIDGE_HOOK_MAX_PER_WORKSPACE';

export type ScheduledHookStatus = 'scheduled' | 'delivered' | 'canceled' | 'missed' | 'failed';

export interface ScheduledHook {
  id: string;
  workspace: string;
  run_at: string;
  message: string;
  status: ScheduledHookStatus;
  created_at: string;
  created_by?: string;
  delivered_at?: string;
  canceled_at?: string;
  missed_at?: string;
  failed_at?: string;
  failure?: string;
}

export interface ScheduledHookStore {
  version: 1;
  hooks: ScheduledHook[];
}

export interface ScheduledHookSchedulerOptions {
  client: Client<true>;
  cfg: Config;
  hooksFilePath: string;
}

export interface ListHooksOptions {
  workspace?: string;
  includeDone?: boolean;
}

const STORE_VERSION = 1;
const HOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MESSAGE_LENGTH = 1800;

function emptyStore(): ScheduledHookStore {
  return { version: STORE_VERSION, hooks: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isHookStatus(value: unknown): value is ScheduledHookStatus {
  return (
    value === 'scheduled' ||
    value === 'delivered' ||
    value === 'canceled' ||
    value === 'missed' ||
    value === 'failed'
  );
}

function parseHook(value: unknown): ScheduledHook | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = asString(value.id);
  const workspace = asString(value.workspace);
  const runAt = asString(value.run_at);
  const message = asString(value.message);
  const status = value.status;
  const createdAt = asString(value.created_at);

  if (
    id === undefined ||
    workspace === undefined ||
    runAt === undefined ||
    message === undefined ||
    !isHookStatus(status) ||
    createdAt === undefined
  ) {
    return undefined;
  }

  return {
    id,
    workspace,
    run_at: runAt,
    message,
    status,
    created_at: createdAt,
    ...(asString(value.created_by) !== undefined ? { created_by: asString(value.created_by) } : {}),
    ...(asString(value.delivered_at) !== undefined
      ? { delivered_at: asString(value.delivered_at) }
      : {}),
    ...(asString(value.canceled_at) !== undefined
      ? { canceled_at: asString(value.canceled_at) }
      : {}),
    ...(asString(value.missed_at) !== undefined ? { missed_at: asString(value.missed_at) } : {}),
    ...(asString(value.failed_at) !== undefined ? { failed_at: asString(value.failed_at) } : {}),
    ...(asString(value.failure) !== undefined ? { failure: asString(value.failure) } : {}),
  };
}

export function validateHookId(id: string): void {
  if (!HOOK_ID_PATTERN.test(id)) {
    throw new Error('hook id must be 1-64 chars: letters, numbers, dot, underscore, dash');
  }
}

export function validateHookMessage(message: string): void {
  if (message.trim().length === 0) {
    throw new Error('hook message is required');
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`hook message is too long; max ${MAX_MESSAGE_LENGTH} chars`);
  }
}

export function validateRunAt(runAt: string, maxScheduleDays: number, now = Date.now()): void {
  const runAtMs = Date.parse(runAt);
  if (!Number.isFinite(runAtMs)) {
    throw new Error('run_at must be a valid ISO 8601 timestamp');
  }

  if (runAtMs <= now) {
    throw new Error('run_at must be in the future');
  }

  const maxMs = now + maxScheduleDays * 24 * 60 * 60 * 1000;
  if (runAtMs > maxMs) {
    throw new Error(`run_at is too far in the future; max ${maxScheduleDays} day(s)`);
  }
}

export async function loadHookStore(filePath: string): Promise<ScheduledHookStore> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyStore();
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid hooks JSON: ${error.message}`);
    }

    throw error;
  }

  if (!isRecord(parsed)) {
    throw new Error('hooks file root must be an object');
  }

  const hooks = Array.isArray(parsed.hooks) ? parsed.hooks.map(parseHook).filter(isDefined) : [];
  return { version: STORE_VERSION, hooks };
}

export async function saveHookStore(filePath: string, store: ScheduledHookStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function mutateHookStore<T>(
  filePath: string,
  mutate: (store: ScheduledHookStore) => T,
): Promise<T> {
  const store = await loadHookStore(filePath);
  const result = mutate(store);
  await saveHookStore(filePath, store);
  return result;
}

export async function listHooks(
  filePath: string,
  options: ListHooksOptions = {},
): Promise<ScheduledHook[]> {
  const store = await loadHookStore(filePath);
  return store.hooks
    .filter((hook) => options.workspace === undefined || hook.workspace === options.workspace)
    .filter((hook) => options.includeDone === true || hook.status === 'scheduled')
    .sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at));
}

export async function cancelHook(filePath: string, workspace: string, id: string): Promise<ScheduledHook> {
  validateHookId(id);
  return mutateHookStore(filePath, (store) => {
    const hook = store.hooks.find(
      (candidate) =>
        candidate.workspace === workspace &&
        candidate.id === id &&
        candidate.status === 'scheduled',
    );

    if (hook === undefined) {
      throw new Error(`scheduled hook not found: ${id}`);
    }

    hook.status = 'canceled';
    hook.canceled_at = new Date().toISOString();
    return hook;
  });
}

function activeHooksForWorkspace(store: ScheduledHookStore, workspace: string): ScheduledHook[] {
  return store.hooks.filter(
    (hook) => hook.workspace === workspace && hook.status === 'scheduled',
  );
}

export async function addHook(
  filePath: string,
  hook: Omit<ScheduledHook, 'status' | 'created_at'>,
  cfg: Config['hooks'],
): Promise<ScheduledHook> {
  validateHookId(hook.id);
  validateHookMessage(hook.message);
  validateRunAt(hook.run_at, cfg.max_schedule_days);

  return mutateHookStore(filePath, (store) => {
    if (
      store.hooks.some(
        (candidate) =>
          candidate.workspace === hook.workspace &&
          candidate.id === hook.id &&
          candidate.status === 'scheduled',
      )
    ) {
      throw new Error(`scheduled hook already exists: ${hook.id}`);
    }

    if (activeHooksForWorkspace(store, hook.workspace).length >= cfg.max_hooks_per_workspace) {
      throw new Error(
        `workspace has too many scheduled hooks; max ${cfg.max_hooks_per_workspace}`,
      );
    }

    const scheduled: ScheduledHook = {
      ...hook,
      status: 'scheduled',
      created_at: new Date().toISOString(),
    };
    store.hooks.push(scheduled);
    return scheduled;
  });
}

function hookDue(hook: ScheduledHook, nowMs: number): boolean {
  return hook.status === 'scheduled' && Date.parse(hook.run_at) <= nowMs;
}

function formatHookMessage(hook: ScheduledHook): string {
  return `⏰ ${hook.id}\n${hook.message}`;
}

async function sendHookMessage(channel: SendableChannels, hook: ScheduledHook): Promise<void> {
  await channel.send({
    content: formatHookMessage(hook),
    embeds: [
      new EmbedBuilder()
        .setTitle('Scheduled hook')
        .setDescription(hook.message)
        .addFields(
          { name: 'ID', value: `\`${hook.id}\``, inline: true },
          { name: 'Workspace', value: `\`${hook.workspace}\``, inline: true },
        )
        .setColor(0x3b82f6),
    ],
  });
}

export function hookAgentInstructions(): string {
  return [
    'The bridge supports scheduled Discord hooks/reminders through a local CLI.',
    'When the user asks to be reminded later or asks to schedule a one-time message, use the command path in DISCORD_BRIDGE_HOOK_CLI.',
    'Register hooks only for static reminder messages, not for autonomous agent execution.',
    'Use: "$DISCORD_BRIDGE_HOOK_CLI" add --id <stable-id> --at <ISO-8601-with-timezone> --message <message>.',
    'Use: "$DISCORD_BRIDGE_HOOK_CLI" list, and "$DISCORD_BRIDGE_HOOK_CLI" cancel --id <id>.',
    'Convert relative times such as tomorrow 9 AM into an exact timestamp with timezone before registering; run `date` first if the current local time is needed.',
    'After registering or canceling, tell the user the hook id and scheduled local time.',
  ].join('\n');
}

export class ScheduledHookScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private options: ScheduledHookSchedulerOptions) {}

  update(options: Omit<ScheduledHookSchedulerOptions, 'client'>): void {
    this.options = { ...options, client: this.options.client };
    if (this.timer !== undefined) {
      this.stop();
      this.start();
    }
  }

  start(): void {
    if (this.timer !== undefined || !this.options.cfg.hooks.enabled) {
      return;
    }

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.cfg.hooks.poll_interval_ms);
  }

  stop(): void {
    if (this.timer === undefined) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running || !this.options.cfg.hooks.enabled) {
      return;
    }

    this.running = true;
    try {
      await this.deliverDueHooks(now);
    } catch (error) {
      console.error('[hooks] scheduler tick failed:', error);
    } finally {
      this.running = false;
    }
  }

  private async deliverDueHooks(now: Date): Promise<void> {
    const nowMs = now.getTime();
    const store = await loadHookStore(this.options.hooksFilePath);
    let changed = false;

    for (const hook of store.hooks.filter((candidate) => hookDue(candidate, nowMs))) {
      const runAtMs = Date.parse(hook.run_at);
      if (nowMs - runAtMs > this.options.cfg.hooks.missed_grace_ms) {
        hook.status = 'missed';
        hook.missed_at = now.toISOString();
        changed = true;
        continue;
      }

      const workspace = this.options.cfg.workspaces.find(
        (candidate) => candidate.name === hook.workspace,
      );
      if (workspace === undefined) {
        hook.status = 'failed';
        hook.failed_at = now.toISOString();
        hook.failure = `workspace not found: ${hook.workspace}`;
        changed = true;
        continue;
      }

      try {
        const channel = await this.options.client.channels.fetch(workspace.channel_id);
        if (channel === null || !channel.isSendable()) {
          throw new Error('target channel is not sendable');
        }

        await sendHookMessage(channel, hook);
        hook.status = 'delivered';
        hook.delivered_at = new Date().toISOString();
      } catch (error) {
        hook.status = 'failed';
        hook.failed_at = new Date().toISOString();
        hook.failure = error instanceof Error ? error.message : String(error);
      }
      changed = true;
    }

    if (changed) {
      await saveHookStore(this.options.hooksFilePath, store);
    }
  }
}
