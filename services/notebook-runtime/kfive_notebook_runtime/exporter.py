"""Export a bounded directory as KFive's hash-checked stdout envelope."""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import stat
import sys
from pathlib import Path

from .contract import ContractError, canonical_json_bytes
from .preload import MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, PATH_RE, SCHEMA


def _files(root: Path, relative: str = "") -> list[tuple[str, bytes]]:
    result: list[tuple[str, bytes]] = []
    try:
        entries = sorted(os.scandir(root / relative), key=lambda item: item.name)
    except OSError as error:
        raise ContractError("INVALID_EXPORT", "Export directory could not be read.") from error
    for entry in entries:
        path = f"{relative}/{entry.name}" if relative else entry.name
        if PATH_RE.fullmatch(path) is None or path.startswith(".") or any(part.startswith(".") for part in path.split("/")):
            raise ContractError("INVALID_EXPORT", "Export path is invalid.")
        metadata = entry.stat(follow_symlinks=False)
        if stat.S_ISLNK(metadata.st_mode):
            raise ContractError("INVALID_EXPORT", "Export contains a symbolic link.")
        if stat.S_ISDIR(metadata.st_mode):
            result.extend(_files(root, path))
            continue
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > MAX_FILE_BYTES:
            raise ContractError("INVALID_EXPORT", "Export contains an unsafe file.")
        with open(entry.path, "rb") as source:
            data = source.read(MAX_FILE_BYTES + 1)
        if len(data) != metadata.st_size or len(data) > MAX_FILE_BYTES:
            raise ContractError("INVALID_EXPORT", "Export file changed while being read.")
        result.append((path, data))
    return result


def encode_directory(root: Path) -> bytes:
    if root.is_symlink() or not root.is_dir():
        raise ContractError("INVALID_EXPORT", "Export root is invalid.")
    files = _files(root)
    if not 1 <= len(files) <= MAX_FILES or sum(len(data) for _, data in files) > MAX_TOTAL_BYTES:
        raise ContractError("INVALID_EXPORT", "Export limits were exceeded.")
    return canonical_json_bytes({
        "schemaVersion": SCHEMA,
        "files": [{
            "path": path,
            "data": base64.b64encode(data).decode("ascii"),
            "sha256": hashlib.sha256(data).hexdigest(),
        } for path, data in files],
    })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export a fixed KFive directory envelope.")
    parser.add_argument("--source", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        sys.stdout.buffer.write(encode_directory(args.source))
    except (ContractError, OSError):
        print("Notebook export failed safely.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

