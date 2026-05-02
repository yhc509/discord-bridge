import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError } from 'zod';

export const providerValues = ['claude', 'codex'] as const;
export type Provider = (typeof providerValues)[number];
export const voiceProviderValues = ['local', 'http'] as const;
export type VoiceProvider = (typeof voiceProviderValues)[number];
export const claudePermissionModeValues = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'plan',
  'bypassPermissions',
] as const;

const workspaceSchema = z.object({
  name: z.string().min(1),
  channel_id: z.string().min(1),
  cwd: z.string().min(1),
  provider: z.enum(providerValues).default('claude'),
});

const voiceSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(voiceProviderValues).default('local'),
    language: z.string().min(1).default('ko'),
    max_audio_mb: z.number().positive().default(25),
    timeout: z.number().int().positive().default(120000),
    concurrency: z.number().int().min(1).max(8).default(1),
    local: z
      .object({
        binary: z.string().min(1).default('whisper-cli'),
        model: z.string().min(1).optional(),
        ffmpeg_binary: z.string().min(1).default('ffmpeg'),
        extra_args: z.array(z.string()).default([]),
      })
      .default({}),
    http: z
      .object({
        url: z.string().url().optional(),
        token: z.string().min(1).optional(),
      })
      .default({}),
    server: z
      .object({
        enabled: z.boolean().default(false),
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(8787),
        token: z.string().min(1).optional(),
      })
      .default({}),
  })
  .default({});

const claudeApprovalSchema = z
  .object({
    enabled: z.boolean().default(false),
    tools: z
      .array(z.string().min(1))
      .default(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
  })
  .default({});

const securitySchema = z
  .object({
    workspace_roots: z.array(z.string().min(1)).default([]),
    warn_public_bind: z.boolean().default(true),
    warn_broad_cwd: z.boolean().default(true),
  })
  .default({});

const configSchema = z.object({
  state_file: z.string().optional(),
  workspaces: z.array(workspaceSchema).min(1),
  discord: z.object({
    bot_token: z.string().min(1),
    guild_id: z.string().min(1),
    user_allowlist: z.array(z.string().min(1)).min(1),
    notify_channel_name: z.string().min(1).default('discord-bridge'),
  }),
  claude: z.object({
    binary: z.string().min(1),
    permission_mode: z.enum(claudePermissionModeValues).default('bypassPermissions'),
    output_format: z.literal('stream-json'),
    model: z.string().min(1).default('claude-opus-4-6[1m]'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    timeout: z.number().default(600000),
    approval: claudeApprovalSchema,
  }),
  codex: z
    .object({
      binary: z.string().min(1).default('codex'),
      model: z.string().min(1).default('gpt-5.5'),
      timeout: z.number().default(600000),
      sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
      approval_policy: z.string().min(1).default('on-request'),
    })
    .default({}),
  voice: voiceSchema,
  security: securitySchema,
});

export type Config = z.infer<typeof configSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;

export async function loadConfig(configPath = './config.json'): Promise<Config> {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid config JSON: ${error.message}`);
    }

    throw error;
  }

  let cfg: Config;

  try {
    cfg = configSchema.parse(parsedJson);
  } catch (error) {
    if (error instanceof ZodError) {
      const fields = error.issues
        .map((issue) => issue.path.join('.') || '<root>')
        .join(', ');

      throw new Error(`Invalid config fields: ${fields}`);
    }

    throw error;
  }

  if (cfg.state_file !== undefined && !path.isAbsolute(cfg.state_file)) {
    throw new Error(`state_file must be absolute: ${cfg.state_file}`);
  }

  const workspaceNames = new Set<string>();
  const workspaceChannelIds = new Set<string>();

  for (const workspace of cfg.workspaces) {
    if (!path.isAbsolute(workspace.cwd)) {
      throw new Error(`workspace.cwd must be absolute for ${workspace.name}: ${workspace.cwd}`);
    }

    if (workspaceNames.has(workspace.name)) {
      throw new Error(`Duplicate workspace.name: ${workspace.name}`);
    }
    workspaceNames.add(workspace.name);

    if (workspaceChannelIds.has(workspace.channel_id)) {
      throw new Error(`Duplicate workspace.channel_id: ${workspace.channel_id}`);
    }
    workspaceChannelIds.add(workspace.channel_id);
  }

  if ((cfg.voice.enabled && cfg.voice.provider === 'local') || cfg.voice.server.enabled) {
    if (cfg.voice.local.model === undefined) {
      throw new Error(
        'voice.local.model is required when local voice transcription or voice.server is enabled',
      );
    }

    if (!path.isAbsolute(cfg.voice.local.model)) {
      throw new Error(`voice.local.model must be absolute: ${cfg.voice.local.model}`);
    }
  }

  if (cfg.voice.enabled && cfg.voice.provider === 'http' && cfg.voice.http.url === undefined) {
    throw new Error('voice.http.url is required when voice.provider is "http"');
  }

  if (
    cfg.voice.server.enabled &&
    cfg.voice.server.token === undefined &&
    !['127.0.0.1', 'localhost', '::1'].includes(cfg.voice.server.host)
  ) {
    throw new Error('voice.server.token is required when voice.server.host is not loopback');
  }

  return cfg;
}

export function getWorkspaceByChannel(cfg: Config, channelId: string): Workspace | undefined {
  return cfg.workspaces.find((workspace) => workspace.channel_id === channelId);
}

export function getWorkspaceByName(cfg: Config, name: string): Workspace | undefined {
  return cfg.workspaces.find((workspace) => workspace.name === name);
}
