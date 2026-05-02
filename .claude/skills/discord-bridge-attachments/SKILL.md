---
name: discord-bridge-attachments
description: Register screenshots, images, and generated files for upload through discord-bridge. Use when Claude is running inside discord-bridge and needs to send a screenshot, rendered image, exported artifact, log bundle, or any local file back to Discord through the bridge attachment outbox.
---

# Discord Bridge Attachments

Use this skill when a file should appear in Discord as an attachment from a
discord-bridge turn.

discord-bridge exposes an outbox directory in `DISCORD_ATTACH_OUTBOX_DIR`. To
upload files, create the files first, then register their absolute paths in that
outbox before the turn ends. The bridge reads the outbox after the turn and
uploads the files.

## Quick Start

After creating a screenshot or file, run the bundled helper. Resolve the script
path relative to this skill folder:

```bash
python3 ".claude/skills/discord-bridge-attachments/scripts/register_attachment.py" /absolute/path/to/file.png
python3 "$HOME/.claude/skills/discord-bridge-attachments/scripts/register_attachment.py" /absolute/path/to/file.png
```

Pass multiple paths to upload multiple files:

```bash
python3 ".claude/skills/discord-bridge-attachments/scripts/register_attachment.py" \
  /absolute/path/to/screenshot.png \
  /absolute/path/to/report.txt
```

## Rules

- Use absolute file paths.
- Register files before the current turn finishes.
- Keep each file under Discord's bridge upload limit, currently 25 MB.
- If `DISCORD_ATTACH_OUTBOX_DIR` is unset, say that automatic Discord upload is unavailable and provide the saved file path.
- Do not paste image data, base64 blobs, or large binary content into chat.
- For Claude, explicitly registering files in the outbox is safe even when image auto-upload might also work.

## Manual Fallback

If the helper cannot be used, write a JSON manifest directly:

```bash
manifest="$DISCORD_ATTACH_OUTBOX_DIR/attachments-$(date +%s).json"
printf '{"paths":["/absolute/path/to/file.png"]}\n' > "$manifest"
```

For multiple files, include every absolute path:

```json
{"paths":["/absolute/path/to/a.png","/absolute/path/to/b.txt"]}
```
