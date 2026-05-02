#!/usr/bin/env python3
"""Register local files for discord-bridge attachment upload."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from uuid import uuid4

DISCORD_FILE_LIMIT = 25 * 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Register one or more local files in DISCORD_ATTACH_OUTBOX_DIR.",
    )
    parser.add_argument("paths", nargs="+", help="Absolute paths to files to upload")
    parser.add_argument(
        "--manifest-name",
        help="Optional manifest filename. Defaults to a unique JSON filename.",
    )
    return parser.parse_args()


def validate_path(raw_path: str) -> str:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        raise SystemExit(f"Path must be absolute: {raw_path}")
    if not path.is_file():
        raise SystemExit(f"File does not exist: {path}")
    if path.stat().st_size > DISCORD_FILE_LIMIT:
        raise SystemExit(f"File is larger than 25 MB: {path}")
    return str(path)


def main() -> None:
    args = parse_args()
    outbox = os.environ.get("DISCORD_ATTACH_OUTBOX_DIR")
    if not outbox:
        raise SystemExit("DISCORD_ATTACH_OUTBOX_DIR is not set")

    outbox_dir = Path(outbox)
    outbox_dir.mkdir(parents=True, exist_ok=True)

    paths = [validate_path(raw_path) for raw_path in args.paths]
    manifest_name = args.manifest_name or f"attachments-{uuid4().hex}.json"
    if not manifest_name.endswith(".json"):
        manifest_name += ".json"

    manifest_path = outbox_dir / Path(manifest_name).name
    manifest_path.write_text(json.dumps({"paths": paths}) + "\n", encoding="utf-8")
    print(manifest_path)


if __name__ == "__main__":
    main()
