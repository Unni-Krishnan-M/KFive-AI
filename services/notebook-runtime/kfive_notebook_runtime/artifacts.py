"""Bounded export of inert notebook-created artifacts and scalar metrics."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from pathlib import Path
from typing import Any, Callable

from .contract import ContractError, canonical_json_bytes, parse_json_bytes, validate_inert_json
from .images import MAX_IMAGE_BYTES, canonicalize_image

MAX_ARTIFACTS = 20
MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_TOTAL_ARTIFACT_BYTES = 4 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024
MAX_METRICS = 1000
MAX_METRICS_BYTES = 128 * 1024
PATH_PART_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
METRIC_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")

ImageCanonicalizer = Callable[[bytes, str], bytes]


def _safe_relative_path(path: Path, root: Path) -> str:
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ContractError("INVALID_ARTIFACT", "Artifact path escapes its export directory.") from error
    if not relative.parts or len(relative.parts) > 8 or any(PATH_PART_RE.fullmatch(part) is None for part in relative.parts):
        raise ContractError("INVALID_ARTIFACT", "Artifact path is not portable and safe.")
    return relative.as_posix()


def _regular_file_bytes(path: Path, *, maximum: int, code: str) -> bytes:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ContractError(code, "Artifact must be a single-link regular file.")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or opened.st_dev != metadata.st_dev or opened.st_ino != metadata.st_ino:
                raise ContractError(code, "Artifact changed while it was being inspected.")
            chunks: list[bytes] = []
            remaining = maximum + 1
            while remaining > 0:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
        finally:
            os.close(descriptor)
    except ContractError:
        raise
    except OSError as error:
        raise ContractError(code, "Artifact could not be read safely.") from error
    if len(data) > maximum:
        raise ContractError(code, "Artifact exceeds its byte limit.")
    return data


def _normalize_artifact(path: Path, image_canonicalizer: ImageCanonicalizer) -> tuple[str, str, bytes]:
    suffix = path.suffix.lower()
    raw = _regular_file_bytes(path, maximum=MAX_ARTIFACT_BYTES, code="INVALID_ARTIFACT")
    if suffix == ".txt":
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ContractError("INVALID_ARTIFACT", "Text artifact must be valid UTF-8.") from error
        return "text", "text/plain; charset=utf-8", text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    if suffix == ".json":
        parsed = parse_json_bytes(raw, code="INVALID_ARTIFACT", maximum_bytes=MAX_ARTIFACT_BYTES)
        validate_inert_json(parsed)
        return "json", "application/json", canonical_json_bytes(parsed)
    if suffix == ".png":
        return "png", "image/png", image_canonicalizer(raw, "png")
    if suffix in {".jpg", ".jpeg"}:
        return "jpeg", "image/jpeg", image_canonicalizer(raw, "jpeg")
    raise ContractError("INVALID_ARTIFACT", "Artifact extension is not allowlisted.")


def _write_exclusive(path: Path, data: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
        finally:
            os.close(descriptor)
    except FileExistsError as error:
        raise ContractError("OUTPUT_COLLISION", "Runtime output path already exists.") from error
    except OSError as error:
        raise ContractError("OUTPUT_WRITE_FAILED", "Runtime output could not be written safely.") from error


def collect_artifacts(
    workspace: Path,
    output_dir: Path,
    *,
    image_canonicalizer: ImageCanonicalizer = canonicalize_image,
) -> list[dict[str, Any]]:
    source_root = workspace / "artifacts"
    if not source_root.exists():
        return []
    if source_root.is_symlink() or not source_root.is_dir():
        raise ContractError("INVALID_ARTIFACT", "Artifact export root must be a regular directory.")

    candidates: list[Path] = []
    for current, directories, files in os.walk(source_root, followlinks=False):
        current_path = Path(current)
        if current_path.is_symlink():
            raise ContractError("INVALID_ARTIFACT", "Artifact directories must not be symlinks.")
        for directory in directories:
            child = current_path / directory
            _safe_relative_path(child, source_root)
            if child.is_symlink():
                raise ContractError("INVALID_ARTIFACT", "Artifact directories must not be symlinks.")
        for filename in files:
            candidate = current_path / filename
            _safe_relative_path(candidate, source_root)
            candidates.append(candidate)
    candidates.sort(key=lambda value: value.relative_to(source_root).as_posix())
    if len(candidates) > MAX_ARTIFACTS:
        raise ContractError("ARTIFACT_LIMIT", f"At most {MAX_ARTIFACTS} artifacts may be exported.")

    records: list[dict[str, Any]] = []
    total = 0
    normalized: list[tuple[str, str, str, bytes]] = []
    for source in candidates:
        relative = _safe_relative_path(source, source_root)
        kind, mime_type, data = _normalize_artifact(source, image_canonicalizer)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ContractError("ARTIFACT_LIMIT", "Canonical artifact exceeds its byte limit.")
        total += len(data)
        if total > MAX_TOTAL_ARTIFACT_BYTES:
            raise ContractError("ARTIFACT_LIMIT", "Artifacts exceed their total byte limit.")
        normalized.append((relative, kind, mime_type, data))

    for relative, kind, mime_type, data in normalized:
        exported = f"artifacts/{relative}"
        _write_exclusive(output_dir / exported, data)
        records.append({
            "path": exported,
            "kind": kind,
            "mimeType": mime_type,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    return records


def read_metrics(workspace: Path) -> list[dict[str, Any]]:
    path = workspace / ".kfive" / "metrics.jsonl"
    if not path.exists():
        return []
    raw = _regular_file_bytes(path, maximum=MAX_METRICS_BYTES, code="INVALID_METRICS")
    try:
        lines = raw.decode("utf-8", errors="strict").splitlines()
    except UnicodeDecodeError as error:
        raise ContractError("INVALID_METRICS", "Metric stream must be valid UTF-8.") from error
    if len(lines) > MAX_METRICS:
        raise ContractError("METRIC_LIMIT", f"At most {MAX_METRICS} metrics may be logged.")
    metrics: list[dict[str, Any]] = []
    for line in lines:
        if not line or len(line.encode("utf-8")) > 256:
            raise ContractError("INVALID_METRICS", "Metric record is malformed.")
        value = parse_json_bytes(line.encode("utf-8"), code="INVALID_METRICS", maximum_bytes=256)
        if not isinstance(value, dict) or set(value) != {"name", "value", "step"}:
            raise ContractError("INVALID_METRICS", "Metric record keys are invalid.")
        name, number, step = value["name"], value["value"], value["step"]
        if not isinstance(name, str) or METRIC_NAME_RE.fullmatch(name) is None:
            raise ContractError("INVALID_METRICS", "Metric name is invalid.")
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(float(number)):
            raise ContractError("INVALID_METRICS", "Metric value must be finite.")
        if step is not None and (
            isinstance(step, bool) or not isinstance(step, int) or not 0 <= step <= 2_147_483_647
        ):
            raise ContractError("INVALID_METRICS", "Metric step is invalid.")
        metrics.append({"name": name, "value": float(number), "step": step})
    return metrics


__all__ = ["collect_artifacts", "read_metrics"]
