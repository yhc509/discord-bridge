import { Buffer } from 'node:buffer';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Attachment, Collection } from 'discord.js';

export const ATTACHMENTS_DIR = '.discord-attachments';
const STALE_AGE_MS = 5 * 60 * 1000;

export const DISCORD_FILE_LIMIT = 25 * 1024 * 1024;

export interface DownloadedAttachment {
  originalName: string;
  localPath: string;
  contentType: string | undefined;
  size: number;
}

export async function downloadAttachments(
  attachments: Collection<string, Attachment>,
  workspaceCwd: string,
  messageId: string,
): Promise<DownloadedAttachment[]> {
  const baseDir = path.join(workspaceCwd, ATTACHMENTS_DIR);
  const messageDir = path.join(baseDir, messageId);
  await cleanupStaleAttachments(baseDir);
  await mkdir(messageDir, { recursive: true });

  const downloaded: DownloadedAttachment[] = [];

  for (const attachment of attachments.values()) {
    if (attachment.size > DISCORD_FILE_LIMIT) {
      continue;
    }

    try {
      const originalName = attachment.name;
      const localPath = path.join(messageDir, `${attachment.id}${path.extname(originalName)}`);
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(localPath, buffer);

      downloaded.push({
        originalName,
        localPath,
        contentType: attachment.contentType ?? undefined,
        size: attachment.size,
      });
    } catch (err) {
      console.error(`[attachments] failed to download ${attachment.name}:`, err);
    }
  }

  return downloaded;
}

async function cleanupStaleAttachments(baseDir: string): Promise<void> {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        const dirPath = path.join(baseDir, entry.name);
        const dirStat = await stat(dirPath);

        if (now - dirStat.mtimeMs > STALE_AGE_MS) {
          await rm(dirPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore per-entry cleanup errors.
      }
    }
  } catch {
    // Base directory may not exist yet.
  }
}

export function formatPromptWithAttachments(
  userText: string,
  attachments: DownloadedAttachment[],
): string {
  if (attachments.length === 0) {
    return userText;
  }

  const text = userText.length > 0 ? userText : 'Please review the attached file(s).';
  const fileList = attachments
    .map((attachment) => `- ${attachment.originalName} → ${attachment.localPath}`)
    .join('\n');

  return `${text}\n\nAttached files (use Read tool to view):\n${fileList}`;
}
