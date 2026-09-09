"""Second-stage verifier for a stopped and removed notebook execution container.

This process executes no notebook code. It treats every candidate byte as untrusted,
revalidates it against the immutable input notebook, and recreates a canonical bundle
in a distinct empty output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from .artifacts import (
    MAX_ARTIFACTS,
    MAX_ARTIFACT_BYTES,
    MAX_METRICS,
    MAX_TOTAL_ARTIFACT_BYTES,
    METRIC_NAME_RE,
    PATH_PART_RE,
)
from .contract import ContractError, RESULT_SCHEMA, canonical_json_bytes, load_job, parse_json_bytes
from .executor import sanitize_executed_notebook
from .images import canonicalize_image

MAX_RESULT_BYTES = 256 * 1024
MAX_EXECUTED_NOTEBOOK_BYTES = 8 * 1024 * 1024
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ISO_MILLISECONDS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

ERROR_MESSAGES = {
    "INVALID_INPUT": "Notebook job input is invalid.",
    "INVALID_MANIFEST": "Notebook job manifest is invalid.",
    "INVALID_NOTEBOOK": "Notebook input is invalid.",
    "CELL_TIMEOUT": "Notebook cell execution timed out.",
    "CELL_EXECUTION_FAILED": "Notebook cell execution failed.",
    "KERNEL_TERMINATED": "Notebook kernel terminated unexpectedly.",
    "KERNEL_FAILED": "Notebook kernel could not complete the run.",
    "RUNTIME_DEPENDENCY_MISSING": "Notebook runtime dependencies are unavailable.",
    "NOTEBOOK_OUTPUT_LIMIT": "Notebook output exceeded a safety limit.",
    "INVALID_NOTEBOOK_OUTPUT": "Notebook output was malformed.",
    "INVALID_ARTIFACT": "Notebook artifact was invalid.",
    "INVALID_METRICS": "Notebook metrics were invalid.",
    "METRIC_LIMIT": "Notebook metrics exceeded a safety limit.",
    "ARTIFACT_LIMIT": "Notebook artifacts exceeded a safety limit.",
    "OUTPUT_TAMPERED": "Notebook attempted to modify supervisor output.",
    "INTERNAL_ERROR": "Notebook runtime failed safely.",
}


class VerificationError(ContractError):
    """A fixed safe failure raised for an untrusted candidate bundle."""

    def __init__(self, message: str = "Notebook output verification failed.", *, stage: str = "unspecified"):
        super().__init__("OUTPUT_VERIFICATION_FAILED", message)
        self.stage = stage


def _read_regular(path: Path, maximum: int) -> bytes:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise VerificationError()
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1
                or opened.st_dev != metadata.st_dev
                or opened.st_ino != metadata.st_ino
            ):
                raise VerificationError()
            chunks: list[bytes] = []
            remaining = maximum + 1
            while remaining:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
        finally:
            os.close(descriptor)
    except VerificationError:
        raise
    except OSError as error:
        raise VerificationError() from error
    data = b"".join(chunks)
    if len(data) > maximum:
        raise VerificationError()
    return data


def _prepare_empty_directory(path: Path) -> None:
    try:
        if path.exists():
            metadata = path.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink() or any(path.iterdir()):
                raise VerificationError("Verified output directory must be an empty regular directory.")
        else:
            path.mkdir(mode=0o700, parents=True)
    except VerificationError:
        raise
    except OSError as error:
        raise VerificationError("Verified output directory could not be prepared.") from error


def _write_exclusive(path: Path, data: bytes) -> None:
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(descriptor)
    except OSError as error:
        raise VerificationError("Verified output could not be written safely.") from error


def _inventory(root: Path) -> tuple[set[str], set[str]]:
    try:
        metadata = root.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or root.is_symlink():
            raise VerificationError()
        files: set[str] = set()
        directories: set[str] = set()
        for current, children, names in os.walk(root, followlinks=False):
            current_path = Path(current)
            if current_path.is_symlink():
                raise VerificationError()
            for child_name in children:
                child = current_path / child_name
                relative = child.relative_to(root).as_posix()
                child_metadata = child.lstat()
                if not stat.S_ISDIR(child_metadata.st_mode) or child.is_symlink():
                    raise VerificationError()
                directories.add(relative)
            for name in names:
                path = current_path / name
                relative = path.relative_to(root).as_posix()
                path_metadata = path.lstat()
                if not stat.S_ISREG(path_metadata.st_mode) or path_metadata.st_nlink != 1:
                    raise VerificationError()
                files.add(relative)
        return files, directories
    except VerificationError:
        raise
    except (OSError, ValueError) as error:
        raise VerificationError() from error


def _timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or ISO_MILLISECONDS_RE.fullmatch(value) is None:
        raise VerificationError()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise VerificationError() from error


def _validate_metrics(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > MAX_METRICS:
        raise VerificationError()
    metrics: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"name", "value", "step"}:
            raise VerificationError()
        name, number, step = item["name"], item["value"], item["step"]
        if not isinstance(name, str) or METRIC_NAME_RE.fullmatch(name) is None:
            raise VerificationError()
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(float(number)):
            raise VerificationError()
        if step is not None and (isinstance(step, bool) or not isinstance(step, int) or not 0 <= step <= 2_147_483_647):
            raise VerificationError()
        metrics.append({"name": name, "value": float(number), "step": step})
    if len(canonical_json_bytes(metrics)) > 128 * 1024:
        raise VerificationError()
    return metrics


def _artifact_path(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("artifacts/"):
        raise VerificationError()
    parts = value.split("/")
    if len(parts) < 2 or len(parts) > 9 or parts[0] != "artifacts" or any(PATH_PART_RE.fullmatch(part) is None for part in parts[1:]):
        raise VerificationError()
    return value


def _canonical_artifact(record: Any, candidate_root: Path) -> tuple[dict[str, Any], bytes]:
    if not isinstance(record, dict) or set(record) != {"path", "kind", "mimeType", "bytes", "sha256"}:
        raise VerificationError()
    path = _artifact_path(record["path"])
    expected = {
        "text": ("text/plain; charset=utf-8", {".txt"}),
        "json": ("application/json", {".json"}),
        "png": ("image/png", {".png"}),
        "jpeg": ("image/jpeg", {".jpg", ".jpeg"}),
    }
    kind = record["kind"]
    if kind not in expected or record["mimeType"] != expected[kind][0] or Path(path).suffix.lower() not in expected[kind][1]:
        raise VerificationError()
    data = _read_regular(candidate_root / path, MAX_ARTIFACT_BYTES)
    if kind == "text":
        try:
            canonical = data.decode("utf-8", errors="strict").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
        except UnicodeDecodeError as error:
            raise VerificationError() from error
    elif kind == "json":
        parsed = parse_json_bytes(data, code="OUTPUT_VERIFICATION_FAILED", maximum_bytes=MAX_ARTIFACT_BYTES)
        canonical = canonical_json_bytes(parsed)
    else:
        canonical = canonicalize_image(data, kind)
    if canonical != data or record["bytes"] != len(data) or record["sha256"] != hashlib.sha256(data).hexdigest():
        raise VerificationError()
    return {"path": path, "kind": kind, "mimeType": expected[kind][0], "bytes": len(data), "sha256": record["sha256"]}, data


def _validate_executed_notebook(value: Any, input_notebook: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise VerificationError()
    try:
        canonical = sanitize_executed_notebook(value)
    except ContractError as error:
        raise VerificationError() from error
    if canonical != value or len(value.get("cells", [])) != len(input_notebook["cells"]):
        raise VerificationError()
    for candidate, original in zip(value["cells"], input_notebook["cells"], strict=True):
        if any(candidate.get(key) != original.get(key) for key in ("cell_type", "id", "metadata", "source")):
            raise VerificationError()
    return canonical


def verify_output(input_dir: Path, candidate_dir: Path, verified_dir: Path, expected_run_id: str) -> dict[str, Any]:
    """Recreate a verified canonical bundle from a quiescent untrusted candidate."""
    _prepare_empty_directory(verified_dir)
    try:
        manifest, input_notebook = load_job(input_dir)
    except ContractError as error:
        raise VerificationError("Trusted notebook input failed revalidation.", stage="input") from error
    if manifest.run_id != expected_run_id:
        raise VerificationError(stage="input-run-id")

    try:
        result_raw = _read_regular(candidate_dir / "result.json", MAX_RESULT_BYTES)
    except VerificationError as error:
        raise VerificationError(stage="result-read") from error
    try:
        result = parse_json_bytes(result_raw, code="OUTPUT_VERIFICATION_FAILED", maximum_bytes=MAX_RESULT_BYTES)
    except ContractError as error:
        raise VerificationError(stage="result-json") from error
    required = {"schemaVersion", "runId", "status", "startedAt", "finishedAt", "durationMs", "notebookFile", "metrics", "artifacts", "error"}
    if not isinstance(result, dict) or set(result) != required or result["schemaVersion"] != RESULT_SCHEMA or result["runId"] != expected_run_id:
        raise VerificationError(stage="result-contract")
    try:
        started = _timestamp(result["startedAt"]); finished = _timestamp(result["finishedAt"])
    except VerificationError as error:
        raise VerificationError(stage="result-time") from error
    duration = result["durationMs"]
    measured = round((finished - started).total_seconds() * 1000)
    if isinstance(duration, bool) or not isinstance(duration, int) or duration < 0 or duration > 300_000 or finished < started or abs(duration - measured) > 2:
        raise VerificationError(stage="result-time")

    try:
        files, directories = _inventory(candidate_dir)
    except VerificationError as error:
        raise VerificationError(stage="candidate-inventory") from error
    if result["status"] == "failed":
        error = result["error"]
        if (
            result["notebookFile"] is not None or result["metrics"] != [] or result["artifacts"] != []
            or files != {"result.json"} or directories
            or not isinstance(error, dict) or set(error) != {"code", "message", "cellIndex"}
            or error["code"] not in ERROR_MESSAGES or error["message"] != ERROR_MESSAGES[error["code"]]
            or (error["cellIndex"] is not None and (isinstance(error["cellIndex"], bool) or not isinstance(error["cellIndex"], int) or not 0 <= error["cellIndex"] < len(input_notebook["cells"])))
        ):
            raise VerificationError(stage="failure-contract")
        canonical_result = {**result, "metrics": [], "artifacts": []}
        _write_exclusive(verified_dir / "result.json", canonical_json_bytes(canonical_result))
        return canonical_result

    if result["status"] != "succeeded" or result["notebookFile"] != "executed.ipynb" or result["error"] is not None:
        raise VerificationError(stage="success-contract")
    try:
        metrics = _validate_metrics(result["metrics"])
    except VerificationError as error:
        raise VerificationError(stage="metrics") from error
    if not isinstance(result["artifacts"], list) or len(result["artifacts"]) > MAX_ARTIFACTS:
        raise VerificationError(stage="artifacts")
    try:
        records_and_data = [_canonical_artifact(item, candidate_dir) for item in result["artifacts"]]
    except (ContractError, OSError) as error:
        raise VerificationError(stage="artifacts") from error
    artifact_records = [item[0] for item in records_and_data]
    if [item["path"] for item in artifact_records] != sorted(item["path"] for item in artifact_records) or len({item["path"] for item in artifact_records}) != len(artifact_records):
        raise VerificationError(stage="artifacts")
    if sum(item["bytes"] for item in artifact_records) > MAX_TOTAL_ARTIFACT_BYTES:
        raise VerificationError(stage="artifacts")
    expected_files = {"result.json", "executed.ipynb", *(item["path"] for item in artifact_records)}
    expected_directories = {str(Path(path).parent).replace(os.sep, "/") for path in expected_files if "/" in path}
    expected_directories |= {parent.as_posix() for path in expected_files for parent in Path(path).parents if parent.as_posix() not in {".", ""}}
    if files != expected_files or directories != expected_directories:
        raise VerificationError(stage="candidate-inventory-match")
    try:
        notebook_raw = _read_regular(candidate_dir / "executed.ipynb", MAX_EXECUTED_NOTEBOOK_BYTES)
    except VerificationError as error:
        raise VerificationError(stage="notebook-read") from error
    try:
        executed = parse_json_bytes(notebook_raw, code="OUTPUT_VERIFICATION_FAILED", maximum_bytes=MAX_EXECUTED_NOTEBOOK_BYTES)
        canonical_notebook = _validate_executed_notebook(executed, input_notebook)
    except ContractError as error:
        raise VerificationError(stage="notebook-contract") from error

    canonical_result = {**result, "metrics": metrics, "artifacts": artifact_records}
    _write_exclusive(verified_dir / "executed.ipynb", canonical_json_bytes(canonical_notebook))
    for record, data in records_and_data:
        _write_exclusive(verified_dir / record["path"], data)
    _write_exclusive(verified_dir / "result.json", canonical_json_bytes(canonical_result))
    return canonical_result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify one stopped KFive notebook execution bundle without running user code.")
    parser.add_argument("--input-dir", type=Path, default=Path("/verify/input"))
    parser.add_argument("--candidate-dir", type=Path, default=Path("/verify/candidate"))
    parser.add_argument("--verified-dir", type=Path, default=Path("/verify/output"))
    parser.add_argument("--run-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        verify_output(args.input_dir, args.candidate_dir, args.verified_dir, args.run_id)
    except VerificationError as error:
        print(f"Notebook output verification failed safely [{error.stage}].", file=sys.stderr)
        return 1
    except (ContractError, OSError):
        print("Notebook output verification failed safely [contract].", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
