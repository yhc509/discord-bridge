#!/usr/bin/env node

const DECISION_ENV = 'DISCORD_BRIDGE_CLAUDE_PERMISSION_DECISION';
const REQUEST_ID_ENV = 'DISCORD_BRIDGE_CLAUDE_PERMISSION_REQUEST_ID';
const DENY_REASON_ENV = 'DISCORD_BRIDGE_CLAUDE_PERMISSION_DENY_REASON';

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(input));
  });
}

function writeDecision(output) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
}

async function main() {
  const input = JSON.parse(await readStdin());
  const decision = process.env[DECISION_ENV] || 'defer';
  const requestId = process.env[REQUEST_ID_ENV];

  if (requestId && input.tool_use_id !== requestId) {
    return;
  }

  if (decision === 'allow') {
    writeDecision({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Approved from Discord',
      updatedInput: input.tool_input || {},
    });
    return;
  }

  if (decision === 'deny') {
    writeDecision({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: process.env[DENY_REASON_ENV] || 'Denied from Discord',
    });
    return;
  }

  writeDecision({
    hookEventName: 'PreToolUse',
    permissionDecision: 'defer',
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
