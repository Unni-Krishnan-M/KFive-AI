"""Populate a mounted tmpfs from a bounded, hash-checked stdin envelope.

This trusted bootstrap runs before notebook code. It exists because Docker
refuses ``docker cp`` into any container whose root filesystem is read-only,
including paths backed by tmpfs.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import os
import re
import sys
from pathlib import Path
from typing import Any

from .contract import ContractError, parse_json_bytes

SCHEMA = "kfive.notebook-files.v1"
MAX_ENVELOPE_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 10 * 1024 * 1024
MAX_FILES = 64
PATH_RE = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+){0,7}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


def _exact(value: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ContractError("INVALID_PRELOAD", "Preload envelope keys are invalid.")
    return value


def decode_envelope(data: bytes) -> list[tuple[str, bytes]]:
    value = _exact(
        parse_json_bytes(data, code="INVALID_PRELOAD", maximum_bytes=MAX_ENVELOPE_BYTES),
        {"schemaVersion", "files"},
    )
    if value["schemaVersion"] != SCHEMA or not isinstance(value["files"], list):
        raise ContractError("INVALID_PRELOAD", "Preload envelope schema is invalid.")
    if not 1 <= len(value["files"]) <= MAX_FILES:
        raise ContractError("INVALID_PRELOAD", "Preload file count is invalid.")
    decoded: list[tuple[str, bytes]] = []
    names: set[str] = set()
    total = 0
    for raw in value["files"]:
        record = _exact(raw, {"path", "data", "sha256"})
        path = record["path"]
        encoded = record["data"]
        digest = record["sha256"]
        if (
            not isinstance(path, str)
            or len(path.encode("utf-8")) > 256
            or PATH_RE.fullmatch(path) is None
            or path.startswith(".")
            or any(part in {".", ".."} or part.startswith(".") for part in path.split("/"))
            or path in names
            or not isinstance(encoded, str)
            or len(encoded) > (MAX_FILE_BYTES * 4 // 3) + 8
            or not isinstance(digest, str)
            or SHA256_RE.fullmatch(digest) is None
        ):
            raise ContractError("INVALID_PRELOAD", "Preload file record is invalid.")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ContractError("INVALID_PRELOAD", "Preload file data is invalid.") from error
        total += len(content)
        if len(content) > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES or hashlib.sha256(content).hexdigest() != digest:
            raise ContractError("INVALID_PRELOAD", "Preload file integrity is invalid.")
        names.add(path)
        decoded.append((path, content))
    return decoded


def populate(destination: Path, files: list[tuple[str, bytes]]) -> None:
    if destination.is_symlink() or not destination.is_dir() or any(destination.iterdir()):
        raise ContractError("INVALID_PRELOAD", "Preload destination is not an empty directory.")
    directories: set[Path] = set()
    for relative, content in files:
        target = destination / relative
        parent = target.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        current = parent
        while current != destination:
            directories.add(current)
            current = current.parent
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(target, flags, 0o444)
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.close(descriptor)
        os.chmod(target, 0o444, follow_symlinks=False)
    for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        os.chmod(directory, 0o555, follow_symlinks=False)
    os.chmod(destination, 0o555, follow_symlinks=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Load a fixed KFive file envelope into an empty tmpfs.")
    parser.add_argument("--destination", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        data = sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1)
        populate(args.destination, decode_envelope(data))
    except (ContractError, OSError):
        print("Notebook preload failed safely.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

