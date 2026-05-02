import { Buffer } from 'node:buffer';

import type { ClaudeEvent } from './parser.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type CodexParseState = { turnStartedAt?: number };

function* processCodexEvent(event: unknown, state: CodexParseState): Generator<ClaudeEvent> {
  if (!isRecord(event)) {
    return;
  }

  const type = asString(event.type);

  if (type === 'thread.started') {
    const threadId = asString(event.thread_id);
    if (threadId !== undefined) {
      yield { type: 'session_init', sessionId: threadId };
    }
    return;
  }

  if (type === 'turn.started') {
    state.turnStartedAt = Date.now();
    return;
  }

  if (type === 'item.started') {
    const item = isRecord(event.item) ? event.item : undefined;
    if (item !== undefined && asString(item.type) === 'command_execution') {
      const command = asString(item.command) ?? '';
      yield {
        type: 'tool_use',
        tool: 'Bash',
        target: command.length > 80 ? command.slice(0, 80) + '…' : command,
      };
    }
    return;
  }

  if (type === 'item.completed') {
    const item = isRecord(event.item) ? event.item : undefined;
    if (item === undefined) {
      return;
    }

    if (asString(item.type) === 'agent_message') {
      const text = asString(item.text);
      if (text !== undefined && text.length > 0) {
        yield { type: 'text_delta', text };
      }
    }
    return;
  }

  if (type === 'turn.completed' || type === 'turn.failed') {
    const usage = isRecord(event.usage) ? event.usage : undefined;
    const inputTokens = usage !== undefined ? (asNumber(usage.input_tokens) ?? 0) : 0;
    const outputTokens = usage !== undefined ? (asNumber(usage.output_tokens) ?? 0) : 0;
    const durationMs =
      state.turnStartedAt !== undefined ? Date.now() - state.turnStartedAt : 0;

    yield {
      type: 'result',
      tokens: inputTokens + outputTokens,
      contextTokens: inputTokens,
      durationMs,
    };

    if (type === 'turn.failed') {
      const error = isRecord(event.error) ? event.error : undefined;
      const errorMsg = error !== undefined ? (asString(error.message) ?? 'turn failed') : 'turn failed';
      yield { type: 'error', message: errorMsg, fatal: true };
    }
  }
}

function parseCodexLine(line: string, state: CodexParseState): ClaudeEvent[] {
  try {
    return [...processCodexEvent(JSON.parse(line) as unknown, state)];
  } catch (error) {
    if (error instanceof SyntaxError) {
      return [
        { type: 'error', message: `malformed NDJSON: ${line.slice(0, 200)}`, fatal: false },
      ];
    }

    return [
      {
        type: 'error',
        message: error instanceof Error ? error.message : 'failed to process NDJSON line',
        fatal: false,
      },
    ];
  }
}

export async function* parseCodexStream(
  stdout: NodeJS.ReadableStream,
): AsyncGenerator<ClaudeEvent> {
  let buffer = '';
  const state: CodexParseState = {};

  for await (const chunk of stdout) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        for (const event of parseCodexLine(line, state)) {
          yield event;
        }
      }

      newlineIndex = buffer.indexOf('\n');
    }
  }

  const line = buffer.trimEnd();
  if (line.length === 0) {
    return;
  }

  try {
    for (const event of processCodexEvent(JSON.parse(line) as unknown, state)) {
      yield event;
    }
  } catch {
    // Ignore malformed trailing data
  }
}
