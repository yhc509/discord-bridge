import { Buffer } from 'node:buffer';

export type ClaudeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'queued'; buffered: number }
  | { type: 'permission_block'; tool: string; reason: string }
  | {
      type: 'result';
      tokens: number;
      contextTokens: number;
      durationMs: number;
      sessionId?: string;
      costUsd?: number;
      contextWindow?: number;
      modelId?: string;
    }
  | { type: 'tool_use'; tool: string; target: string; diff?: string; filePath?: string }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'session_init'; sessionId: string };

type JsonRecord = Record<string, unknown>;
type StreamParseState = { lastAssistantUsage?: JsonRecord; lastAssistantHadText?: boolean };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractContent(event: JsonRecord): unknown[] {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }

  return message.content;
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function permissionDenialToEvent(denial: unknown): ClaudeEvent {
  if (typeof denial === 'string') {
    return { type: 'permission_block', tool: 'unknown', reason: denial };
  }

  if (isRecord(denial)) {
    return {
      type: 'permission_block',
      tool: firstString(denial, ['tool_name', 'name', 'tool']) ?? 'unknown',
      reason: firstString(denial, ['reason', 'message', 'rule']) ?? 'permission denied',
    };
  }

  return { type: 'permission_block', tool: 'unknown', reason: 'permission denied' };
}

function* permissionDenialEvents(event: JsonRecord): Generator<ClaudeEvent> {
  const permissionDenials = event.permission_denials;
  if (!Array.isArray(permissionDenials)) {
    return;
  }

  for (const denial of permissionDenials) {
    yield permissionDenialToEvent(denial);
  }
}

function shortenPath(p: string): string {
  const match = p.match(/(?:^|\/)(src|scripts|dist|config|tests?|\.claude)\/.*/);
  if (match !== null) return match[0].replace(/^\//, '');
  const parts = p.split('/');
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

function toolTarget(tool: string, input: JsonRecord): string {
  const filePath = asString(input.file_path);
  const short = filePath !== undefined ? shortenPath(filePath) : undefined;

  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return short ?? '';
    case 'Grep': {
      const pattern = asString(input.pattern) ?? '';
      const path = asString(input.path);
      return `"${pattern}"${path !== undefined ? ` ${shortenPath(path)}` : ''}`;
    }
    case 'Glob': {
      const pattern = asString(input.pattern) ?? '';
      const path = asString(input.path);
      return `${pattern}${path !== undefined ? ` ${shortenPath(path)}` : ''}`;
    }
    case 'Bash': {
      const cmd = asString(input.command) ?? '';
      return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
    }
    case 'ToolSearch':
    case 'WebSearch': {
      const query = asString(input.query) ?? '';
      return query.length > 80 ? query.slice(0, 80) + '…' : query;
    }
    case 'WebFetch': {
      const url = asString(input.url) ?? '';
      return url.length > 80 ? url.slice(0, 80) + '…' : url;
    }
    case 'Agent':
      return '';
    default:
      return short ?? asString(input.query) ?? asString(input.description) ?? '';
  }
}

function toolDiff(tool: string, input: JsonRecord): { diff?: string } {
  if (tool !== 'Edit') return {};
  const oldStr = asString(input.old_string);
  const newStr = asString(input.new_string);
  if (oldStr === undefined || newStr === undefined) return {};

  const oldLines = oldStr.split('\n').map((l: string) => `- ${l}`);
  const newLines = newStr.split('\n').map((l: string) => `+ ${l}`);
  const diffText = [...oldLines, ...newLines].join('\n');
  if (diffText.length > 500) {
    return { diff: diffText.slice(0, 500) + '\n… (truncated)' };
  }
  return { diff: diffText };
}

function* processEvent(event: unknown, state: StreamParseState): Generator<ClaudeEvent> {
  if (!isRecord(event)) {
    return;
  }

  const eventType = asString(event.type);
  const subtype = asString(event.subtype);

  if (eventType === 'system' && subtype === 'init') {
    const sessionId = asString(event.session_id);
    if (sessionId !== undefined) {
      yield { type: 'session_init', sessionId };
    }
    return;
  }

  if (eventType === 'assistant') {
    const message = event.message;
    if (isRecord(message) && isRecord(message.usage)) {
      state.lastAssistantUsage = message.usage;
    }

    let hasTextThisMessage = false;
    for (const block of extractContent(event)) {
      if (!isRecord(block)) {
        continue;
      }

      if (block.type === 'text') {
        const text = asString(block.text);
        if (text !== undefined && text.length > 0) {
          if (state.lastAssistantHadText && !hasTextThisMessage) {
            yield { type: 'text_delta', text: '\n\n' };
          }
          hasTextThisMessage = true;
          yield { type: 'text_delta', text };
        }
        continue;
      }

      if (block.type === 'tool_use') {
        const toolName = asString(block.name);
        if (toolName !== undefined) {
          const input = isRecord(block.input) ? block.input : {};
          const rawFilePath = asString(input.file_path);
          yield {
            type: 'tool_use',
            tool: toolName,
            target: toolTarget(toolName, input),
            ...toolDiff(toolName, input),
            ...(rawFilePath !== undefined ? { filePath: rawFilePath } : {}),
          };
        }
        continue;
      }
    }

    if (hasTextThisMessage) {
      state.lastAssistantHadText = true;
    }
    return;
  }

  if (eventType === 'result') {
    yield* permissionDenialEvents(event);

    const usage = event.usage;
    const inputTokens = isRecord(usage) ? asNumber(usage.input_tokens) ?? 0 : 0;
    const outputTokens = isRecord(usage) ? asNumber(usage.output_tokens) ?? 0 : 0;
    const usageForContext = state.lastAssistantUsage ?? (isRecord(usage) ? usage : undefined);
    const contextTokens = usageForContext !== undefined
      ? (asNumber(usageForContext.input_tokens) ?? 0) +
        (asNumber(usageForContext.cache_creation_input_tokens) ?? 0) +
        (asNumber(usageForContext.cache_read_input_tokens) ?? 0)
      : 0;
    const modelUsage = event.modelUsage;
    const primaryModelEntry = isRecord(modelUsage)
      ? Object.entries(modelUsage).reduce<[string, JsonRecord] | undefined>((best, [key, val]) => {
          if (!isRecord(val)) return best;
          const cw = asNumber(val.contextWindow) ?? 0;
          const bestCw = best !== undefined ? (asNumber(best[1].contextWindow) ?? 0) : -1;
          return cw > bestCw ? [key, val] : best;
        }, undefined)
      : undefined;
    const primaryModelUsage = primaryModelEntry?.[1];
    const modelId = primaryModelEntry?.[0];
    const contextWindow = asNumber(primaryModelUsage?.contextWindow);
    const durationMs = asNumber(event.duration_ms) ?? 0;
    const sessionId = asString(event.session_id);
    const costUsd = asNumber(event.total_cost_usd);

    yield {
      type: 'result',
      tokens: inputTokens + outputTokens,
      contextTokens,
      durationMs,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
    };

    if (subtype === 'error' || event.is_error === true) {
      yield {
        type: 'error',
        message:
          asString(event.error) ??
          (subtype === 'error' ? 'result subtype=error' : 'result is_error=true'),
        fatal: true,
      };
    }
  }
}

function parseLine(line: string, state: StreamParseState): ClaudeEvent[] {
  try {
    const event = JSON.parse(line) as unknown;
    return [...processEvent(event, state)];
  } catch (error) {
    if (error instanceof SyntaxError) {
      return [
        {
          type: 'error',
          message: `malformed NDJSON: ${line.slice(0, 200)}`,
          fatal: false,
        },
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

export async function* parseStream(stdout: NodeJS.ReadableStream): AsyncGenerator<ClaudeEvent> {
  let buffer = '';
  const state: StreamParseState = {};

  for await (const chunk of stdout) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        for (const event of parseLine(line, state)) {
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
    for (const event of processEvent(JSON.parse(line) as unknown, state)) {
      yield event;
    }
  } catch {
    // Ignore malformed trailing data at EOF; complete lines already report parse errors.
  }
}
