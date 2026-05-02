import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type Provider, providerValues } from '../config.js';

export interface PersistedEntry {
  sessionId?: string;
  provider?: Provider;
  startedAtMs?: number;
  lastPromptAtMs?: number;
  messageCount?: number;
  lastPromptPreview?: string;
  interruptedTurnPrompt?: string;
  interruptedTurnStartedAtMs?: number;
  pendingQueue?: Array<{
    id: string;
    prompt: string;
    preview: string;
    queuedAtMs: number;
    hiddenInstructions?: string;
    internalMode?: boolean;
  }>;
  pendingPermission?: {
    id: string;
    tool: string;
    target: string;
  };
  completedTurns?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  lastTurnTokens?: number;
  lastTurnCostUsd?: number;
  lastTurnDurationMs?: number;
  lastContextTokens?: number;
  lastContextWindow?: number;
  lastModelId?: string;
}

export type PersistedMap = Record<string, PersistedEntry>;

const persistedMapSchema = z.record(
  z.string(),
  z.object({
    sessionId: z.string().optional(),
    provider: z.enum(providerValues).optional(),
    startedAtMs: z.number().optional(),
    lastPromptAtMs: z.number().optional(),
    messageCount: z.number().int().nonnegative().optional(),
    lastPromptPreview: z.string().optional(),
    interruptedTurnPrompt: z.string().optional(),
    interruptedTurnStartedAtMs: z.number().optional(),
    pendingQueue: z
      .array(
        z.object({
          id: z.string(),
          prompt: z.string(),
          preview: z.string(),
          queuedAtMs: z.number(),
          hiddenInstructions: z.string().optional(),
          internalMode: z.boolean().optional(),
        }),
      )
      .optional(),
    pendingPermission: z
      .object({
        id: z.string(),
        tool: z.string(),
        target: z.string(),
      })
      .optional(),
    completedTurns: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative().optional(),
    lastTurnTokens: z.number().int().nonnegative().optional(),
    lastTurnCostUsd: z.number().nonnegative().optional(),
    lastTurnDurationMs: z.number().int().nonnegative().optional(),
    lastContextTokens: z.number().int().nonnegative().optional(),
    lastContextWindow: z.number().int().positive().optional(),
    lastModelId: z.string().optional(),
  }),
);

export async function loadPersistedState(filePath: string): Promise<PersistedMap> {
  await cleanupTempFiles(filePath);

  let content: string;

  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    const result = persistedMapSchema.safeParse(parsed);

    if (!result.success) {
      console.warn(`Ignoring invalid persisted session state at ${filePath}:`, result.error);
      return {};
    }

    return result.data;
  } catch (error) {
    console.warn(`Ignoring invalid persisted session state at ${filePath}:`, error);
    return {};
  }
}

export async function savePersistedState(
  filePath: string,
  state: PersistedMap,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const json = `${JSON.stringify(state, null, 2)}\n`;

  await mkdir(dir, { recursive: true });

  let handle = await open(tempPath, 'wx');
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tempPath, filePath);
  await syncDirectory(dir);
}

async function cleanupTempFiles(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPrefix = `.${path.basename(filePath)}.`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    console.debug(`Could not scan persisted state dir for temp files: ${dir}`, error);
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(tempPrefix) && entry.endsWith('.tmp'))
      .map(async (entry) => {
        try {
          await rm(path.join(dir, entry), { force: true });
        } catch (error) {
          console.debug(`Could not remove persisted state temp file: ${entry}`, error);
        }
      }),
  );
}

async function syncDirectory(dir: string): Promise<void> {
  let dirHandle;
  try {
    dirHandle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    console.debug(`Skipping directory fsync for ${dir}:`, error);
    return;
  }

  try {
    await dirHandle.sync();
  } catch (error) {
    console.debug(`Skipping directory fsync for ${dir}:`, error);
  } finally {
    await dirHandle.close();
  }
}
