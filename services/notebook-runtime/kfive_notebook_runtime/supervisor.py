"""One-shot process entrypoint. It never starts a listening Jupyter service."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import stat
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .artifacts import collect_artifacts, read_metrics
from .contract import ContractError, RESULT_SCHEMA, RUN_ID_RE, canonical_json_bytes, load_job
from .executor import ExecutionFailure, NbClientEngine, NotebookEngine, sanitize_executed_notebook

RESULT_FILENAME = "result.json"
EXECUTED_NOTEBOOK_FILENAME = "executed.ipynb"


def _utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _prepare_directory(path: Path, *, empty: bool, code: str) -> None:
    try:
        if path.exists():
            metadata = path.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
                raise ContractError(code, "Runtime directory must be a regular directory.")
        else:
            path.mkdir(mode=0o700, parents=True)
        if empty and any(path.iterdir()):
            raise ContractError(code, "Runtime directory must be empty at job start.")
    except ContractError:
        raise
    except OSError as error:
        raise ContractError(code, "Runtime directory could not be prepared safely.") from error


def _ensure_output_still_empty(path: Path) -> None:
    try:
        if path.is_symlink() or not path.is_dir() or any(path.iterdir()):
            raise ContractError("OUTPUT_TAMPERED", "Output directory changed during notebook execution.")
    except OSError as error:
        raise ContractError("OUTPUT_TAMPERED", "Output directory could not be inspected safely.") from error


def _atomic_write(path: Path, value: Any) -> None:
    data = canonical_json_bytes(value)
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        descriptor = os.open(
            temporary,
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
        os.replace(temporary, path)
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise ContractError("OUTPUT_WRITE_FAILED", "Runtime result could not be written safely.") from error


def _error_message(code: str) -> str:
    return {
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
    }.get(code, "Notebook runtime failed safely.")


def _safe_run_id_from_manifest(input_dir: Path) -> str | None:
    try:
        raw = json.loads((input_dir / "manifest.json").read_text(encoding="utf-8"))
        value = raw.get("runId") if isinstance(raw, dict) else None
        return value if isinstance(value, str) and RUN_ID_RE.fullmatch(value) else None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


@contextmanager
def _runtime_environment(workspace: Path):
    home = workspace / ".home"
    temporary = workspace / ".tmp"
    matplotlib = workspace / ".matplotlib"
    ipython = workspace / ".ipython"
    jupyter_config = workspace / ".jupyter" / "config"
    jupyter_data = workspace / ".jupyter" / "data"
    jupyter_runtime = workspace / ".jupyter" / "runtime"
    for directory in (home, temporary, matplotlib, ipython, jupyter_config, jupyter_data, jupyter_runtime):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    values = {
        "KFIVE_METRIC_FILE": str(workspace / ".kfive" / "metrics.jsonl"),
        "HOME": str(home),
        "TMPDIR": str(temporary),
        "MPLCONFIGDIR": str(matplotlib),
        "IPYTHONDIR": str(ipython),
        "JUPYTER_CONFIG_DIR": str(jupyter_config),
        "JUPYTER_DATA_DIR": str(jupyter_data),
        "JUPYTER_RUNTIME_DIR": str(jupyter_runtime),
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PIP_NO_INDEX": "1",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    }
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def execute_job(
    input_dir: Path,
    output_dir: Path,
    workspace: Path,
    *,
    engine: NotebookEngine | None = None,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    started = clock()
    run_id = _safe_run_id_from_manifest(input_dir)
    _prepare_directory(output_dir, empty=True, code="INVALID_OUTPUT")
    _prepare_directory(workspace, empty=True, code="INVALID_WORKSPACE")
    status = "failed"
    notebook_file: str | None = None
    metrics: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    error_record: dict[str, Any] | None = None
    with _runtime_environment(workspace):
        try:
            manifest, notebook = load_job(input_dir)
            run_id = manifest.run_id
            executed = (engine or NbClientEngine()).execute(
                notebook,
                workspace=workspace,
                cell_timeout_seconds=manifest.cell_timeout_seconds,
            )
            sanitized = sanitize_executed_notebook(executed)
            _ensure_output_still_empty(output_dir)
            metrics = read_metrics(workspace)
            artifacts = collect_artifacts(workspace, output_dir)
            _atomic_write(output_dir / EXECUTED_NOTEBOOK_FILENAME, sanitized)
            notebook_file = EXECUTED_NOTEBOOK_FILENAME
            status = "succeeded"
        except ExecutionFailure as error:
            error_record = {
                "code": error.code,
                "message": _error_message(error.code),
                "cellIndex": error.cell_index,
            }
        except ContractError as error:
            error_record = {"code": error.code, "message": _error_message(error.code), "cellIndex": None}
        except Exception:
            error_record = {"code": "INTERNAL_ERROR", "message": _error_message("INTERNAL_ERROR"), "cellIndex": None}

    finished = clock()
    result = {
        "schemaVersion": RESULT_SCHEMA,
        "runId": run_id,
        "status": status,
        "startedAt": _utc_iso(started),
        "finishedAt": _utc_iso(finished),
        "durationMs": max(0, round((finished - started) * 1000)),
        "notebookFile": notebook_file,
        "metrics": metrics,
        "artifacts": artifacts,
        "error": error_record,
    }
    _atomic_write(output_dir / RESULT_FILENAME, result)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Execute exactly one validated KFive notebook job.")
    parser.add_argument("--input-dir", type=Path, default=Path("/work/input"))
    parser.add_argument("--output-dir", type=Path, default=Path("/work/output"))
    parser.add_argument("--workspace-dir", type=Path, default=Path("/work/run"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = execute_job(args.input_dir, args.output_dir, args.workspace_dir)
    except ContractError:
        print("Notebook supervisor could not write a safe result.", file=sys.stderr)
        return 70
    return 0 if result["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
