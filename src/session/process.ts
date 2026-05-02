import { spawn } from 'node:child_process';

import { type ClaudeEvent, parseStream } from './parser.js';

export interface InvokeArgs {
  cwd: string;
  binary: string;
  prompt: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
  continueSession: boolean;
  resumeSessionId?: string;
  permissionMode: 'bypassPermissions';
  outputFormat: 'stream-json';
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface InvokeHandle {
  events: AsyncGenerator<ClaudeEvent>;
  kill(): void;
  done: Promise<void>;
}

interface QueueItem {
  event?: ClaudeEvent;
  done?: true;
}

class EventQueue {
  private readonly items: QueueItem[] = [];
  private waiting: (() => void) | undefined;
  private closed = false;

  push(event: ClaudeEvent): void {
    if (this.closed) {
      return;
    }

    this.items.push({ event });
    this.notify();
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.items.push({ done: true });
    this.notify();
  }

  async shift(): Promise<QueueItem> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }

    return this.items.shift()!;
  }

  private notify(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }
}

const MAX_STDERR_BUFFER_BYTES = 64 * 1024;

export function spawnAndStream(
  binary: string,
  argv: string[],
  cwd: string,
  stdin: string,
  parser: (stdout: NodeJS.ReadableStream) => AsyncGenerator<ClaudeEvent>,
  label: string,
  timeoutMs = 600_000,
  extraEnv?: NodeJS.ProcessEnv,
): InvokeHandle {
  const child = spawn(binary, argv, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  let seenFatalError = false;
  let parseDone = false;
  let closeSeen = false;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  let timedOut = false;

  const queue = new EventQueue();
  const done = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });

  const pushFatalError = (message: string): void => {
    if (seenFatalError) {
      return;
    }

    seenFatalError = true;
    queue.push({ type: 'error', message, fatal: true });
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    pushFatalError(`${label} timed out after ${timeoutMs / 1000}s`);
    child.kill('SIGTERM');
  }, timeoutMs);

  const maybeFinish = (): void => {
    if (!closeSeen || !parseDone) {
      return;
    }

    clearTimeout(timeout);

    if (closeCode !== 0 && !timedOut && !seenFatalError) {
      const signalPart = closeSignal ? ` signal ${closeSignal}` : '';
      const stderrPart = stderrBuf ? `: ${stderrBuf}` : '';
      pushFatalError(`${label} exited with code ${closeCode}${signalPart}${stderrPart}`);
    }

    queue.close();
  };

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk;
    if (Buffer.byteLength(stderrBuf, 'utf8') <= MAX_STDERR_BUFFER_BYTES) {
      return;
    }

    const trimmed = Buffer.from(stderrBuf, 'utf8').subarray(-MAX_STDERR_BUFFER_BYTES);
    stderrBuf = trimmed.toString('utf8');
  });

  child.once('error', (err) => {
    pushFatalError(`spawn failed: ${err.message}`);
    queue.close();
  });

  child.once('close', (code, signal) => {
    closeSeen = true;
    closeCode = code;
    closeSignal = signal;
    maybeFinish();
  });

  void (async () => {
    try {
      for await (const event of parser(child.stdout!)) {
        queue.push(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushFatalError(`failed to parse ${label} output: ${message}`);
    } finally {
      parseDone = true;
      maybeFinish();
    }
  })();

  child.stdin?.end(stdin);

  async function* events(): AsyncGenerator<ClaudeEvent> {
    while (true) {
      const item = await queue.shift();
      if (item.done) {
        return;
      }

      yield item.event!;
    }
  }

  return {
    events: events(),
    kill(): void {
      child.kill('SIGTERM');
    },
    done,
  };
}

export function invoke(args: InvokeArgs): InvokeHandle {
  const argv = [
    '-p',
    '--output-format',
    args.outputFormat,
    '--verbose',
    '--permission-mode',
    args.permissionMode,
    '--model',
    args.model,
    '--effort',
    args.effort,
  ];

  if (args.resumeSessionId) {
    argv.push('--resume', args.resumeSessionId);
  } else if (args.continueSession) {
    argv.push('--continue');
  }

  if (args.appendSystemPrompt) {
    argv.push('--append-system-prompt', args.appendSystemPrompt);
  }

  return spawnAndStream(
    args.binary,
    argv,
    args.cwd,
    args.prompt,
    parseStream,
    'claude',
    args.timeoutMs,
    args.extraEnv,
  );
}
