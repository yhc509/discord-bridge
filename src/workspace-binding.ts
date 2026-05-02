import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Config, Provider, Workspace } from './config.js';

export const DEFAULT_BIND_CONFIG_PATH = './config.json';
export const DEFAULT_BIND_DEV_ROOT = '~/Dev';
export const DEFAULT_BIND_PROVIDER: Provider = 'codex';

export interface BindWorkspaceRequest {
  cfg: Config;
  channelId: string;
  channelName: string;
  provider?: Provider;
  devRoot?: string;
  name?: string;
  cwd?: string;
  configPath?: string;
}

export interface BindWorkspacePreview {
  workspace: Workspace;
  configPath: string;
  devRoot: string;
  channelName: string;
}

export interface UnbindWorkspaceRequest {
  cfg: Config;
  channelId: string;
  configPath?: string;
}

export interface UnbindWorkspacePreview {
  workspace: Workspace;
  configPath: string;
}

interface RawConfig {
  workspaces: unknown[];
  [key: string]: unknown;
}

let configWriteQueue: Promise<void> = Promise.resolve();

async function withConfigWriteLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = configWriteQueue.catch(() => undefined);
  let release!: () => void;
  configWriteQueue = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );

  await previous;

  try {
    return await run();
  } finally {
    release();
  }
}

export function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function assertSafeWorkspaceName(name: string): void {
  if (name.length === 0) {
    throw new Error('workspace name is required');
  }

  if (name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error(`unsafe workspace name: ${name}`);
  }

  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`unsafe workspace name: ${name}`);
  }
}

export async function ensureDevRoot(devRoot: string): Promise<string> {
  const resolved = path.resolve(expandHome(devRoot));

  try {
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) {
      throw new Error(`dev root is not a directory: ${resolved}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('dev root is not a directory:')) {
      throw error;
    }

    throw new Error(`dev root does not exist: ${resolved}`);
  }

  return realpath(resolved);
}

export function assertInsideRoot(root: string, cwd: string): string {
  const resolved = path.resolve(expandHome(cwd));
  const relative = path.relative(root, resolved);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`workspace cwd must be inside dev root: ${resolved}`);
  }

  return resolved;
}

function resolveWorkspaceCwd(devRoot: string, cwd: string | undefined, workspaceName: string): string {
  const input = cwd?.trim();
  if (!input) {
    return path.join(devRoot, workspaceName);
  }

  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.join(devRoot, expanded);
}

export function validateNoDuplicateWorkspace(cfg: Config, workspace: Workspace): void {
  for (const existing of cfg.workspaces) {
    if (existing.name === workspace.name) {
      throw new Error(`workspace name already exists: ${workspace.name}`);
    }

    if (existing.channel_id === workspace.channel_id) {
      throw new Error('this channel is already bound');
    }
  }
}

export async function previewWorkspaceBinding(
  request: BindWorkspaceRequest,
): Promise<BindWorkspacePreview> {
  const configPath = path.resolve(request.configPath ?? DEFAULT_BIND_CONFIG_PATH);
  const devRoot = await ensureDevRoot(request.devRoot ?? DEFAULT_BIND_DEV_ROOT);
  const workspaceName = request.name?.trim() || request.channelName;

  assertSafeWorkspaceName(workspaceName);

  const cwd = assertInsideRoot(devRoot, resolveWorkspaceCwd(devRoot, request.cwd, workspaceName));
  const workspace: Workspace = {
    name: workspaceName,
    channel_id: request.channelId,
    cwd,
    provider: request.provider ?? DEFAULT_BIND_PROVIDER,
  };

  validateNoDuplicateWorkspace(request.cfg, workspace);

  return {
    workspace,
    configPath,
    devRoot,
    channelName: request.channelName,
  };
}

async function readRawConfig(configPath: string): Promise<RawConfig> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid config JSON: ${error.message}`);
    }

    throw error;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config root must be an object');
  }

  const rawConfig = parsed as Record<string, unknown>;
  if (!Array.isArray(rawConfig.workspaces)) {
    throw new Error('config.workspaces must be an array');
  }

  return rawConfig as RawConfig;
}

export async function writeConfigWithBackup(
  configPath: string,
  cfg: RawConfig,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backupPath = `${configPath}.bak.${timestamp}`;
  const tempPath = `${configPath}.tmp.${process.pid}.${randomUUID()}`;

  await copyFile(configPath, backupPath);
  await writeFile(tempPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, configPath);

  return backupPath;
}

export async function applyWorkspaceBinding(
  preview: BindWorkspacePreview,
): Promise<{ backupPath: string; workspace: Workspace; configPath: string }> {
  return withConfigWriteLock(async () => {
    const rawConfig = await readRawConfig(preview.configPath);
    if (
      rawConfig.workspaces.some((workspace) =>
        hasWorkspaceName(workspace, preview.workspace.name),
      )
    ) {
      throw new Error(`workspace name already exists: ${preview.workspace.name}`);
    }

    if (
      rawConfig.workspaces.some((workspace) =>
        hasChannelId(workspace, preview.workspace.channel_id),
      )
    ) {
      throw new Error('this channel is already bound');
    }

    const nextConfig: RawConfig = {
      ...rawConfig,
      workspaces: [...rawConfig.workspaces, preview.workspace],
    };

    await mkdir(preview.workspace.cwd, { recursive: true });
    const backupPath = await writeConfigWithBackup(preview.configPath, nextConfig);

    return {
      backupPath,
      workspace: preview.workspace,
      configPath: preview.configPath,
    };
  });
}

export function previewWorkspaceUnbinding(
  request: UnbindWorkspaceRequest,
): UnbindWorkspacePreview {
  const workspace = request.cfg.workspaces.find(
    (candidate) => candidate.channel_id === request.channelId,
  );
  if (workspace === undefined) {
    throw new Error('this channel is not bound to any workspace');
  }

  if (request.cfg.workspaces.length <= 1) {
    throw new Error('cannot unbind the last workspace');
  }

  return {
    workspace,
    configPath: path.resolve(request.configPath ?? DEFAULT_BIND_CONFIG_PATH),
  };
}

function hasChannelId(value: unknown, channelId: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).channel_id === channelId
  );
}

function hasWorkspaceName(value: unknown, name: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).name === name
  );
}

export async function applyWorkspaceUnbinding(
  preview: UnbindWorkspacePreview,
): Promise<{ backupPath: string; workspace: Workspace; configPath: string }> {
  return withConfigWriteLock(async () => {
    const rawConfig = await readRawConfig(preview.configPath);
    const nextWorkspaces = rawConfig.workspaces.filter(
      (workspace) => !hasChannelId(workspace, preview.workspace.channel_id),
    );

    if (nextWorkspaces.length === rawConfig.workspaces.length) {
      throw new Error('this channel is not bound to any workspace');
    }

    if (nextWorkspaces.length === 0) {
      throw new Error('cannot unbind the last workspace');
    }

    const nextConfig: RawConfig = {
      ...rawConfig,
      workspaces: nextWorkspaces,
    };
    const backupPath = await writeConfigWithBackup(preview.configPath, nextConfig);

    return {
      backupPath,
      workspace: preview.workspace,
      configPath: preview.configPath,
    };
  });
}
