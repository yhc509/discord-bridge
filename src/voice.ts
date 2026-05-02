import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { DownloadedAttachment } from './attachments.js';
import type { Config, VoiceProvider } from './config.js';

type VoiceConfig = Config['voice'];

const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aiff',
  '.flac',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
]);
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface VoiceTranscript {
  attachment: DownloadedAttachment;
  text: string;
  provider: VoiceProvider;
  durationMs: number;
}

export interface VoiceTranscriptionFailure {
  attachment: DownloadedAttachment;
  error: string;
}

export interface VoiceTranscriptionResult {
  audioAttachments: DownloadedAttachment[];
  transcripts: VoiceTranscript[];
  failures: VoiceTranscriptionFailure[];
}

export interface VoiceTranscriber {
  provider: VoiceProvider;
  transcribe(attachment: DownloadedAttachment): Promise<VoiceTranscript>;
}

export interface VoiceTranscriptionServer {
  close(): Promise<void>;
}

export function createVoiceTranscriber(voice: VoiceConfig): VoiceTranscriber | undefined {
  if (!voice.enabled) {
    return undefined;
  }

  const transcriber =
    voice.provider === 'local'
      ? createRawLocalVoiceTranscriber(voice)
      : createHttpVoiceTranscriber(voice);

  return limitVoiceConcurrency(transcriber, voice.concurrency);
}

export function createLocalVoiceTranscriber(voice: VoiceConfig): VoiceTranscriber {
  return limitVoiceConcurrency(createRawLocalVoiceTranscriber(voice), voice.concurrency);
}

function createRawLocalVoiceTranscriber(voice: VoiceConfig): VoiceTranscriber {
  if (voice.local.model === undefined) {
    throw new Error('voice.local.model is required for local voice transcription');
  }

  return new LocalVoiceTranscriber(voice);
}

export function isAudioAttachment(attachment: DownloadedAttachment): boolean {
  if (attachment.contentType?.toLowerCase().startsWith('audio/')) {
    return true;
  }

  return AUDIO_EXTENSIONS.has(path.extname(attachment.originalName).toLowerCase());
}

export async function transcribeVoiceAttachments(
  voice: VoiceConfig,
  transcriber: VoiceTranscriber | undefined,
  attachments: DownloadedAttachment[],
): Promise<VoiceTranscriptionResult> {
  const audioAttachments = attachments.filter(isAudioAttachment);

  if (!voice.enabled || transcriber === undefined || audioAttachments.length === 0) {
    return { audioAttachments: [], transcripts: [], failures: [] };
  }

  const maxBytes = Math.floor(voice.max_audio_mb * 1024 * 1024);
  const transcripts: VoiceTranscript[] = [];
  const failures: VoiceTranscriptionFailure[] = [];

  for (const attachment of audioAttachments) {
    if (attachment.size > maxBytes) {
      failures.push({
        attachment,
        error: `audio is larger than voice.max_audio_mb (${voice.max_audio_mb} MB)`,
      });
      continue;
    }

    try {
      transcripts.push(await transcriber.transcribe(attachment));
    } catch (error) {
      failures.push({
        attachment,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { audioAttachments, transcripts, failures };
}

export function formatVoicePrompt(
  userText: string,
  result: VoiceTranscriptionResult,
): string {
  const parts: string[] = [];
  const trimmedText = userText.trim();

  if (trimmedText.length > 0) {
    parts.push(trimmedText);
  }

  if (result.transcripts.length > 0) {
    const transcriptBlocks = result.transcripts.map((transcript) => {
      const title = `From ${transcript.attachment.originalName}:`;
      return `${title}\n${transcript.text}`;
    });
    parts.push(`Discord voice input transcript:\n\n${transcriptBlocks.join('\n\n')}`);
  }

  if (result.failures.length > 0) {
    const failureLines = result.failures.map(
      (failure) => `- ${failure.attachment.originalName}: ${failure.error}`,
    );
    parts.push(`Voice transcription failed:\n${failureLines.join('\n')}`);
  }

  return parts.join('\n\n');
}

export function excludeAudioAttachments(
  attachments: DownloadedAttachment[],
  result: VoiceTranscriptionResult,
): DownloadedAttachment[] {
  const audioPaths = new Set(result.audioAttachments.map((attachment) => attachment.localPath));
  return attachments.filter((attachment) => !audioPaths.has(attachment.localPath));
}

export async function startVoiceTranscriptionServer(
  voice: VoiceConfig,
  transcriber: VoiceTranscriber | undefined,
): Promise<VoiceTranscriptionServer | undefined> {
  if (!voice.server.enabled) {
    return undefined;
  }

  if (transcriber === undefined) {
    throw new Error('voice.server requires a local voice transcriber');
  }

  const server = http.createServer((req, res) => {
    void handleVoiceServerRequest(voice, transcriber, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once('error', onError);
    server.listen(voice.server.port, voice.server.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  console.log(
    `[voice] transcription server listening on ${voice.server.host}:${voice.server.port}`,
  );

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

function createHttpVoiceTranscriber(voice: VoiceConfig): VoiceTranscriber {
  if (voice.http.url === undefined) {
    throw new Error('voice.http.url is required for HTTP voice transcription');
  }

  return new HttpVoiceTranscriber(voice);
}

function limitVoiceConcurrency(transcriber: VoiceTranscriber, limit: number): VoiceTranscriber {
  const maxActive = Math.max(1, limit);
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = (): void => {
    if (active >= maxActive) {
      return;
    }

    const next = queue.shift();
    if (next === undefined) {
      return;
    }

    active += 1;
    next();
  };

  return {
    provider: transcriber.provider,
    transcribe: (attachment) =>
      new Promise<VoiceTranscript>((resolve, reject) => {
        queue.push(() => {
          transcriber
            .transcribe(attachment)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              runNext();
            });
        });
        runNext();
      }),
  };
}

class LocalVoiceTranscriber implements VoiceTranscriber {
  readonly provider = 'local' as const;

  constructor(private readonly voice: VoiceConfig) {}

  async transcribe(attachment: DownloadedAttachment): Promise<VoiceTranscript> {
    if (this.voice.local.model === undefined) {
      throw new Error('voice.local.model is required for local voice transcription');
    }

    const startedAt = Date.now();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discord-bridge-voice-'));
    const wavPath = path.join(tempDir, 'audio.wav');

    try {
      await runCommand(
        this.voice.local.ffmpeg_binary,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          attachment.localPath,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wavPath,
        ],
        this.voice.timeout,
      );

      const result = await runCommand(
        this.voice.local.binary,
        [
          '-m',
          this.voice.local.model,
          '-f',
          wavPath,
          '-l',
          this.voice.language,
          '-nt',
          '-np',
          ...this.voice.local.extra_args,
        ],
        this.voice.timeout,
      );
      const text = cleanWhisperOutput(result.stdout);

      if (text.length === 0) {
        throw new Error(`whisper produced an empty transcript${formatProcessError(result.stderr)}`);
      }

      return {
        attachment,
        text,
        provider: this.provider,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

class HttpVoiceTranscriber implements VoiceTranscriber {
  readonly provider = 'http' as const;

  constructor(private readonly voice: VoiceConfig) {}

  async transcribe(attachment: DownloadedAttachment): Promise<VoiceTranscript> {
    if (this.voice.http.url === undefined) {
      throw new Error('voice.http.url is required for HTTP voice transcription');
    }

    const startedAt = Date.now();
    const url = new URL(this.voice.http.url);
    if (!url.searchParams.has('language')) {
      url.searchParams.set('language', this.voice.language);
    }

    const buffer = await readFile(attachment.localPath);
    const headers: Record<string, string> = {
      'content-type': attachment.contentType ?? 'application/octet-stream',
      'x-file-name': encodeURIComponent(attachment.originalName),
      'x-voice-language': this.voice.language,
    };

    if (this.voice.http.token !== undefined) {
      headers.authorization = `Bearer ${this.voice.http.token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: new Blob([new Uint8Array(buffer)], {
        type: attachment.contentType ?? 'application/octet-stream',
      }),
      signal: AbortSignal.timeout(this.voice.timeout),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`voice HTTP transcription failed (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as unknown;
    const text = extractTranscriptText(payload);

    if (text === undefined || text.length === 0) {
      throw new Error('voice HTTP transcription returned no transcript text');
    }

    return {
      attachment,
      text,
      provider: this.provider,
      durationMs: Date.now() - startedAt,
    };
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runCommand(binary: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      const nextBytes = stdoutBytes + chunk.byteLength;
      if (stdoutBytes < MAX_PROCESS_OUTPUT_BYTES) {
        stdout += chunk
          .subarray(0, Math.max(0, MAX_PROCESS_OUTPUT_BYTES - stdoutBytes))
          .toString('utf8');
      }
      stdoutBytes = nextBytes;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const nextBytes = stderrBytes + chunk.byteLength;
      if (stderrBytes < MAX_PROCESS_OUTPUT_BYTES) {
        stderr += chunk
          .subarray(0, Math.max(0, MAX_PROCESS_OUTPUT_BYTES - stderrBytes))
          .toString('utf8');
      }
      stderrBytes = nextBytes;
    });

    child.once('error', (error) => {
      finish(() => reject(error));
    });

    child.once('close', (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`${binary} timed out after ${timeoutMs}ms`));
          return;
        }

        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(
          new Error(
            `${binary} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}: ${stderr.trim()}`,
          ),
        );
      });
    });
  });
}

function cleanWhisperOutput(output: string): string {
  return output
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*\[[^\]]+\]\s*/, '')
        .replace(/^\s*\(.+?\)\s*/, '')
        .trim(),
    )
    .filter((line) => {
      if (line.length === 0) {
        return false;
      }

      return !/^(whisper_|main:|system_info:|sampling strategy:|loading model)/i.test(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatProcessError(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const summary = trimmed.split('\n').slice(-5).join('\n');
  return `: ${summary}`;
}

function extractTranscriptText(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const value = record.text ?? record.transcript;

  return typeof value === 'string' ? value.trim() : undefined;
}

async function handleVoiceServerRequest(
  voice: VoiceConfig,
  transcriber: VoiceTranscriber,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/transcribe') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (!isAuthorizedVoiceServerRequest(voice, req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const body = await readRequestBody(req, Math.floor(voice.max_audio_mb * 1024 * 1024));
    const originalName = decodeHeaderFilename(req.headers['x-file-name']) ?? 'audio';
    const extension = path.extname(originalName) || '.audio';
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discord-bridge-voice-server-'));
    const localPath = path.join(tempDir, `input${extension}`);

    try {
      await writeFile(localPath, body);
      const transcript = await transcriber.transcribe({
        originalName,
        localPath,
        contentType:
          typeof req.headers['content-type'] === 'string'
            ? req.headers['content-type']
            : undefined,
        size: body.byteLength,
      });

      sendJson(res, 200, {
        text: transcript.text,
        provider: transcript.provider,
        duration_ms: transcript.durationMs,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isAuthorizedVoiceServerRequest(voice: VoiceConfig, req: IncomingMessage): boolean {
  if (voice.server.token === undefined) {
    return true;
  }

  return req.headers.authorization === `Bearer ${voice.server.token}`;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxBytes) {
      throw new HttpError(413, `audio is larger than voice.max_audio_mb`);
    }

    chunks.push(buffer);
  }

  if (totalBytes === 0) {
    throw new HttpError(400, 'request body is empty');
  }

  return Buffer.concat(chunks);
}

function decodeHeaderFilename(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }

  try {
    return path.basename(decodeURIComponent(raw));
  } catch {
    return path.basename(raw);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload)}\n`);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
