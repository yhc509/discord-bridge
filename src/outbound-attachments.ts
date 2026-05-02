import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DISCORD_ATTACH_OUTBOX_ENV = 'DISCORD_ATTACH_OUTBOX_DIR';

type OutboxEntry = { paths?: unknown };

export async function createAttachmentOutbox(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'discord-bridge-attach', randomUUID());
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readAttachmentOutbox(outboxDir: string): Promise<string[]> {
  let entries: string[];

  try {
    entries = await readdir(outboxDir);
  } catch {
    return [];
  }

  const collected: string[] = [];

  for (const entry of entries.sort()) {
    const filePath = path.join(outboxDir, entry);

    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as OutboxEntry;
      if (!Array.isArray(parsed.paths)) {
        continue;
      }

      for (const candidate of parsed.paths) {
        if (typeof candidate === 'string' && candidate.length > 0) {
          collected.push(candidate);
        }
      }
    } catch {
      // Ignore malformed outbox entries and continue.
    }
  }

  return collected;
}

export async function cleanupAttachmentOutbox(outboxDir: string): Promise<void> {
  await rm(outboxDir, { recursive: true, force: true });
}
