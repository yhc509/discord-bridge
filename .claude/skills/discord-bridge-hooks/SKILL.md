---
name: discord-bridge-hooks
description: Schedule, list, or cancel one-time Discord reminder hooks when Claude is running inside discord-bridge. Use when the user asks to be reminded later, says to schedule a message, or asks about bridge hooks/reminders.
---

# Discord Bridge Hooks

Use this skill when the user asks for a one-time reminder or scheduled Discord message from a discord-bridge workspace.

discord-bridge exposes a local hook CLI in `DISCORD_BRIDGE_HOOK_CLI`. The scheduler later posts due hooks back to the bound Discord channel.

## Quick Start

For a reminder request, convert the requested time to an exact ISO 8601 timestamp with timezone, then register a static message:

```bash
"$DISCORD_BRIDGE_HOOK_CLI" add \
  --id deploy-check \
  --at 2026-05-07T09:00:00+09:00 \
  --message "배포 상태 확인"
```

List and cancel hooks:

```bash
"$DISCORD_BRIDGE_HOOK_CLI" list
"$DISCORD_BRIDGE_HOOK_CLI" cancel --id deploy-check
```

## Rules

- If `DISCORD_BRIDGE_HOOK_CLI` is unset, say scheduled hooks are unavailable in this environment.
- For relative times such as "tomorrow morning" or "in 30 minutes", run `date` first and convert to a concrete local timestamp with timezone.
- Ask a short clarification if the requested time is ambiguous enough to risk the wrong schedule.
- Register only static reminder messages. Do not schedule autonomous Claude/Codex execution.
- Use a stable hook ID: lowercase words, numbers, dots, underscores, or dashes; max 64 characters.
- After adding or canceling, tell the user the hook ID and scheduled local time.

## Example

User: `내일 오전 9시에 배포 확인하라고 알려줘`

Action:

```bash
date
"$DISCORD_BRIDGE_HOOK_CLI" add \
  --id deploy-check-0900 \
  --at 2026-05-07T09:00:00+09:00 \
  --message "배포 확인"
```

Reply: `등록했어. hook id는 deploy-check-0900, 시간은 2026-05-07 09:00 KST야.`
