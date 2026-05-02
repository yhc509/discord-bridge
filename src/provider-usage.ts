import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Provider } from './config.js';

const execFile = promisify(execFileCb);
const CLAUDE_USAGE_TIMEOUT_MS = 15_000;
const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_USAGE_USER_AGENT = 'claude-code/2.1';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

type JsonRecord = Record<string, unknown>;

export interface ProviderUsageSnapshot {
  provider: Provider;
  planName?: string;
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: Date | null;
  sevenDayUsedPercent: number | null;
  sevenDayResetAt: Date | null;
  sourceLabel: string;
  capturedAt?: Date;
  modelContextWindow?: number;
  lastContextTokens?: number;
  lastTurnTokens?: number;
  unavailableReason?: string;
}

interface ClaudeCredentials {
  accessToken: string;
  subscriptionType: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePercent(value: unknown): number | null {
  const numberValue = asNumber(value);
  if (numberValue === undefined) {
    return null;
  }

  return Math.max(0, Math.min(100, numberValue));
}

function parseIsoDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) {
    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUnixSecondsDate(value: unknown): Date | null {
  const numberValue = asNumber(value);
  if (numberValue === undefined) {
    return null;
  }

  const date = new Date(numberValue * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function titleCase(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }

  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function getClaudeConfigDir(homeDir: string): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured && configured.length > 0 ? configured : path.join(homeDir, '.claude');
}

function getClaudeKeychainServiceName(configDir: string, homeDir: string): string {
  const normalizedConfigDir = path.normalize(path.resolve(configDir));
  const normalizedDefaultDir = path.normalize(path.resolve(path.join(homeDir, '.claude')));
  if (normalizedConfigDir === normalizedDefaultDir) {
    return CLAUDE_KEYCHAIN_SERVICE;
  }

  const hash = createHash('sha256').update(normalizedConfigDir).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

function getClaudeKeychainServiceNames(homeDir: string): string[] {
  const configDir = getClaudeConfigDir(homeDir);
  return [...new Set([getClaudeKeychainServiceName(configDir, homeDir), CLAUDE_KEYCHAIN_SERVICE])];
}

function parseClaudeCredentialBlob(raw: string, nowMs: number): ClaudeCredentials | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const oauth = parsed.claudeAiOauth;
    if (!isRecord(oauth)) {
      return null;
    }

    const accessToken = asString(oauth.accessToken);
    if (!accessToken) {
      return null;
    }

    const expiresAt = asNumber(oauth.expiresAt);
    if (expiresAt !== undefined && expiresAt <= nowMs) {
      return null;
    }

    return {
      accessToken,
      subscriptionType: asString(oauth.subscriptionType) ?? '',
    };
  } catch {
    return null;
  }
}

async function readClaudeKeychainCredentials(homeDir: string, nowMs: number): Promise<ClaudeCredentials | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  const username = os.userInfo().username.trim();
  for (const serviceName of getClaudeKeychainServiceNames(homeDir)) {
    const attempts: string[][] = username
      ? [
          ['find-generic-password', '-s', serviceName, '-a', username, '-w'],
          ['find-generic-password', '-s', serviceName, '-w'],
        ]
      : [['find-generic-password', '-s', serviceName, '-w']];

    for (const args of attempts) {
      try {
        const { stdout } = await execFile('/usr/bin/security', args, {
          encoding: 'utf8',
          timeout: 3_000,
        });
        const credentials = parseClaudeCredentialBlob(stdout.trim(), nowMs);
        if (credentials) {
          return credentials;
        }
      } catch {
        // Try the next lookup path.
      }
    }
  }

  return null;
}

async function readClaudeFileCredentials(homeDir: string, nowMs: number): Promise<ClaudeCredentials | null> {
  const credentialsPath = path.join(getClaudeConfigDir(homeDir), '.credentials.json');
  try {
    const raw = await readFile(credentialsPath, 'utf8');
    return parseClaudeCredentialBlob(raw, nowMs);
  } catch {
    return null;
  }
}

function claudePlanName(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.includes('max')) {
    return 'Max';
  }
  if (normalized.includes('pro')) {
    return 'Pro';
  }
  if (normalized.includes('team')) {
    return 'Team';
  }
  if (normalized.includes('api')) {
    return undefined;
  }

  return subscriptionType;
}

async function getClaudeUsageSnapshot(): Promise<ProviderUsageSnapshot> {
  const homeDir = os.homedir();
  const nowMs = Date.now();
  const credentials =
    (await readClaudeKeychainCredentials(homeDir, nowMs)) ??
    (await readClaudeFileCredentials(homeDir, nowMs));

  if (!credentials) {
    return {
      provider: 'claude',
      fiveHourUsedPercent: null,
      fiveHourResetAt: null,
      sevenDayUsedPercent: null,
      sevenDayResetAt: null,
      sourceLabel: 'Anthropic OAuth usage API',
      unavailableReason: 'OAuth credentials not found',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_USAGE_TIMEOUT_MS);

  try {
    const response = await fetch(CLAUDE_USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': CLAUDE_USAGE_USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        provider: 'claude',
        planName: claudePlanName(credentials.subscriptionType),
        fiveHourUsedPercent: null,
        fiveHourResetAt: null,
        sevenDayUsedPercent: null,
        sevenDayResetAt: null,
        sourceLabel: 'Anthropic OAuth usage API',
        unavailableReason: `HTTP ${response.status}`,
      };
    }

    const payload = (await response.json()) as unknown;
    const data = isRecord(payload) ? payload : {};

    return {
      provider: 'claude',
      planName: claudePlanName(credentials.subscriptionType),
      fiveHourUsedPercent: parsePercent(isRecord(data.five_hour) ? data.five_hour.utilization : undefined),
      fiveHourResetAt: parseIsoDate(isRecord(data.five_hour) ? data.five_hour.resets_at : undefined),
      sevenDayUsedPercent: parsePercent(
        isRecord(data.seven_day) ? data.seven_day.utilization : undefined,
      ),
      sevenDayResetAt: parseIsoDate(
        isRecord(data.seven_day) ? data.seven_day.resets_at : undefined,
      ),
      sourceLabel: 'Anthropic OAuth usage API',
      capturedAt: new Date(),
    };
  } catch (error) {
    return {
      provider: 'claude',
      planName: claudePlanName(credentials.subscriptionType),
      fiveHourUsedPercent: null,
      fiveHourResetAt: null,
      sevenDayUsedPercent: null,
      sevenDayResetAt: null,
      sourceLabel: 'Anthropic OAuth usage API',
      unavailableReason: error instanceof Error ? error.message : 'request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface CodexTokenCountSnapshot {
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: Date | null;
  sevenDayUsedPercent: number | null;
  sevenDayResetAt: Date | null;
  planName?: string;
  capturedAt?: Date;
  modelContextWindow?: number;
  lastContextTokens?: number;
  lastTurnTokens?: number;
}

const snapshotCache = new Map<Provider, { expiresAt: number; snapshot: ProviderUsageSnapshot }>();
const SNAPSHOT_CACHE_MS = 30_000;

async function listJsonlFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && fullPath.endsWith('.jsonl')) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

async function mostRecentFiles(rootDir: string, limit: number): Promise<string[]> {
  const files = await listJsonlFiles(rootDir);
  const withStats = await Promise.all(
    files.map(async (filePath) => {
      try {
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );

  return withStats
    .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

function parseCodexTokenCountLine(line: string): CodexTokenCountSnapshot | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== 'event_msg' || !isRecord(parsed.payload)) {
      return null;
    }

    if (parsed.payload.type !== 'token_count' || !isRecord(parsed.payload.rate_limits)) {
      return null;
    }

    const snapshot: CodexTokenCountSnapshot = {
      fiveHourUsedPercent: null,
      fiveHourResetAt: null,
      sevenDayUsedPercent: null,
      sevenDayResetAt: null,
      planName: titleCase(asString(parsed.payload.rate_limits.plan_type)),
      ...(parseIsoDate(parsed.timestamp) ? { capturedAt: parseIsoDate(parsed.timestamp)! } : {}),
    };

    if (isRecord(parsed.payload.info)) {
      const modelContextWindow = asNumber(parsed.payload.info.model_context_window);
      if (modelContextWindow !== undefined) {
        snapshot.modelContextWindow = modelContextWindow;
      }

      const lastTokenUsage = isRecord(parsed.payload.info.last_token_usage)
        ? parsed.payload.info.last_token_usage
        : undefined;
      if (lastTokenUsage) {
        const inputTokens = asNumber(lastTokenUsage.input_tokens) ?? 0;
        const totalTokens = asNumber(lastTokenUsage.total_tokens);
        snapshot.lastContextTokens = inputTokens;
        snapshot.lastTurnTokens = totalTokens ?? inputTokens + (asNumber(lastTokenUsage.output_tokens) ?? 0);
      }
    }

    for (const key of ['primary', 'secondary'] as const) {
      const limit = parsed.payload.rate_limits[key];
      if (!isRecord(limit)) {
        continue;
      }

      const windowMinutes = asNumber(limit.window_minutes);
      if (windowMinutes === 300) {
        snapshot.fiveHourUsedPercent = parsePercent(limit.used_percent);
        snapshot.fiveHourResetAt = parseUnixSecondsDate(limit.resets_at);
      } else if (windowMinutes === 10_080) {
        snapshot.sevenDayUsedPercent = parsePercent(limit.used_percent);
        snapshot.sevenDayResetAt = parseUnixSecondsDate(limit.resets_at);
      }
    }

    return snapshot;
  } catch {
    return null;
  }
}

async function getCodexUsageSnapshot(): Promise<ProviderUsageSnapshot> {
  const rootDir = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'sessions');
  const candidates = await mostRecentFiles(rootDir, 12);

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.trimEnd().split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const snapshot = parseCodexTokenCountLine(lines[index]!);
        if (!snapshot) {
          continue;
        }

        return {
          provider: 'codex',
          planName: snapshot.planName,
          fiveHourUsedPercent: snapshot.fiveHourUsedPercent,
          fiveHourResetAt: snapshot.fiveHourResetAt,
          sevenDayUsedPercent: snapshot.sevenDayUsedPercent,
          sevenDayResetAt: snapshot.sevenDayResetAt,
          sourceLabel: 'latest local Codex session',
          ...(snapshot.capturedAt ? { capturedAt: snapshot.capturedAt } : {}),
          ...(snapshot.modelContextWindow !== undefined
            ? { modelContextWindow: snapshot.modelContextWindow }
            : {}),
          ...(snapshot.lastContextTokens !== undefined
            ? { lastContextTokens: snapshot.lastContextTokens }
            : {}),
          ...(snapshot.lastTurnTokens !== undefined
            ? { lastTurnTokens: snapshot.lastTurnTokens }
            : {}),
        };
      }
    } catch {
      // Try the next candidate file.
    }
  }

  return {
    provider: 'codex',
    fiveHourUsedPercent: null,
    fiveHourResetAt: null,
    sevenDayUsedPercent: null,
    sevenDayResetAt: null,
    sourceLabel: 'latest local Codex session',
    unavailableReason: 'token_count snapshot not found',
  };
}

export async function getProviderUsageSnapshot(provider: Provider): Promise<ProviderUsageSnapshot> {
  const now = Date.now();
  const cached = snapshotCache.get(provider);
  if (cached && cached.expiresAt > now) {
    return cached.snapshot;
  }

  const snapshot =
    provider === 'codex' ? await getCodexUsageSnapshot() : await getClaudeUsageSnapshot();
  snapshotCache.set(provider, {
    snapshot,
    expiresAt: now + SNAPSHOT_CACHE_MS,
  });
  return snapshot;
}
