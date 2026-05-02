import { parseCodexStream } from './codex-parser.js';
import { spawnAndStream, type InvokeHandle } from './process.js';

export interface CodexInvokeArgs {
  cwd: string;
  binary: string;
  prompt: string;
  developerInstructions?: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
  resumeThreadId?: string;
  model: string;
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: string;
}

function formatConfigOverride(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

export function invokeCodex(args: CodexInvokeArgs): InvokeHandle {
  const hasPrompt = args.prompt.trim().length > 0;
  const commonArgs = [
    '-c',
    formatConfigOverride('approval_policy', args.approvalPolicy),
    '-c',
    formatConfigOverride('sandbox_mode', args.sandboxMode),
    ...(args.developerInstructions !== undefined
      ? ['-c', formatConfigOverride('developer_instructions', args.developerInstructions)]
      : []),
    '--json',
    '-m',
    args.model,
  ];

  const argv = ['exec', '--skip-git-repo-check'];

  if (args.resumeThreadId) {
    argv.push('resume', ...commonArgs, args.resumeThreadId);
    if (hasPrompt) {
      argv.push('-');
    }
  } else {
    argv.push(...commonArgs, '-C', args.cwd, '-');
  }

  return spawnAndStream(
    args.binary,
    argv,
    args.cwd,
    args.prompt,
    parseCodexStream,
    'codex',
    args.timeoutMs,
    args.extraEnv,
  );
}
