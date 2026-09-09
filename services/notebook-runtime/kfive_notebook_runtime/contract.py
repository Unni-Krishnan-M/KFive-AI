"""Strict, stdlib-only validation for the notebook runtime contract."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

JOB_SCHEMA = "kfive.notebook-job.v1"
RESULT_SCHEMA = "kfive.notebook-result.v1"
NOTEBOOK_FILENAME = "notebook.ipynb"
MAX_MANIFEST_BYTES = 8 * 1024
MAX_NOTEBOOK_BYTES = 1024 * 1024
MAX_CELLS = 32
MAX_CELL_SOURCE_BYTES = 64 * 1024
MAX_TOTAL_SOURCE_BYTES = 256 * 1024
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CELL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TAG_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


class ContractError(ValueError):
    """A safe validation failure that can be returned to the broker."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class JobManifest:
    run_id: str
    cell_timeout_seconds: int


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("INVALID_JSON", "JSON object keys must be unique.")
        result[key] = value
    return result


def parse_json_bytes(data: bytes, *, code: str, maximum_bytes: int) -> Any:
    if len(data) > maximum_bytes:
        raise ContractError(code, "Input exceeds the configured byte limit.")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ContractError(code, "Input must be valid UTF-8.") from error
    try:
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ContractError("INVALID_JSON", "JSON numbers must be finite.")
            ),
        )
    except ContractError:
        raise
    except (json.JSONDecodeError, RecursionError) as error:
        raise ContractError(code, "Input must be valid JSON.") from error


def read_regular_file(path: Path, *, maximum_bytes: int, code: str) -> bytes:
    try:
        if path.is_symlink() or not path.is_file():
            raise ContractError(code, "Input must be a regular non-symlink file.")
        with path.open("rb") as source:
            data = source.read(maximum_bytes + 1)
    except OSError as error:
        raise ContractError(code, "Input could not be read safely.") from error
    if len(data) > maximum_bytes:
        raise ContractError(code, "Input exceeds the configured byte limit.")
    return data


def validate_manifest(value: Any) -> JobManifest:
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion", "runId", "notebookFile", "cellTimeoutSeconds"
    }:
        raise ContractError("INVALID_MANIFEST", "Manifest keys do not match the v1 contract.")
    if value["schemaVersion"] != JOB_SCHEMA:
        raise ContractError("INVALID_MANIFEST", "Manifest schemaVersion is unsupported.")
    run_id = value["runId"]
    if not isinstance(run_id, str) or RUN_ID_RE.fullmatch(run_id) is None:
        raise ContractError("INVALID_MANIFEST", "Manifest runId is invalid.")
    if value["notebookFile"] != NOTEBOOK_FILENAME:
        raise ContractError("INVALID_MANIFEST", "Manifest notebookFile must be notebook.ipynb.")
    timeout = value["cellTimeoutSeconds"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 30:
        raise ContractError("INVALID_MANIFEST", "Cell timeout must be an integer from 1 through 30.")
    return JobManifest(run_id=run_id, cell_timeout_seconds=timeout)


def _validate_notebook_metadata(value: Any) -> None:
    if not isinstance(value, dict) or not set(value).issubset({"kernelspec", "language_info"}):
        raise ContractError("INVALID_NOTEBOOK", "Notebook metadata is not canonical.")
    kernelspec = value.get("kernelspec")
    if kernelspec is not None:
        if not isinstance(kernelspec, dict) or set(kernelspec) != {"display_name", "language", "name"}:
            raise ContractError("INVALID_NOTEBOOK", "Notebook kernelspec is not canonical.")
        if kernelspec["name"] != "python3" or kernelspec["language"] != "python":
            raise ContractError("INVALID_NOTEBOOK", "Only the fixed Python 3 kernel is supported.")
        if not isinstance(kernelspec["display_name"], str) or len(kernelspec["display_name"]) > 128:
            raise ContractError("INVALID_NOTEBOOK", "Notebook kernelspec display name is invalid.")
    language_info = value.get("language_info")
    if language_info is not None:
        if not isinstance(language_info, dict) or not set(language_info).issubset({"name", "version"}):
            raise ContractError("INVALID_NOTEBOOK", "Notebook language metadata is not canonical.")
        if language_info.get("name") != "python":
            raise ContractError("INVALID_NOTEBOOK", "Only Python notebook metadata is supported.")
        version = language_info.get("version")
        if version is not None and (not isinstance(version, str) or len(version) > 32):
            raise ContractError("INVALID_NOTEBOOK", "Notebook language version is invalid.")


def _validate_cell_metadata(value: Any) -> None:
    if not isinstance(value, dict) or not set(value).issubset({"tags"}):
        raise ContractError("INVALID_NOTEBOOK", "Cell metadata is not canonical.")
    tags = value.get("tags", [])
    if not isinstance(tags, list) or len(tags) > 16:
        raise ContractError("INVALID_NOTEBOOK", "Cell tags are invalid.")
    if any(not isinstance(tag, str) or TAG_RE.fullmatch(tag) is None for tag in tags):
        raise ContractError("INVALID_NOTEBOOK", "Cell tags are invalid.")
    if len(set(tags)) != len(tags):
        raise ContractError("INVALID_NOTEBOOK", "Cell tags must be unique.")


def validate_notebook(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"nbformat", "nbformat_minor", "metadata", "cells"}:
        raise ContractError("INVALID_NOTEBOOK", "Notebook keys do not match the canonical v4 contract.")
    if value["nbformat"] != 4:
        raise ContractError("INVALID_NOTEBOOK", "Only nbformat 4 notebooks are supported.")
    minor = value["nbformat_minor"]
    if isinstance(minor, bool) or not isinstance(minor, int) or not 0 <= minor <= 5:
        raise ContractError("INVALID_NOTEBOOK", "Notebook minor version is unsupported.")
    _validate_notebook_metadata(value["metadata"])
    cells = value["cells"]
    if not isinstance(cells, list) or not 1 <= len(cells) <= MAX_CELLS:
        raise ContractError("INVALID_NOTEBOOK", f"Notebook must contain 1 through {MAX_CELLS} cells.")

    total_source_bytes = 0
    cell_ids: set[str] = set()
    for cell in cells:
        if not isinstance(cell, dict):
            raise ContractError("INVALID_NOTEBOOK", "Every notebook cell must be an object.")
        cell_type = cell.get("cell_type")
        expected = (
            {"cell_type", "id", "metadata", "source", "execution_count", "outputs"}
            if cell_type == "code"
            else {"cell_type", "id", "metadata", "source"}
        )
        if cell_type not in {"code", "markdown"} or set(cell) != expected:
            raise ContractError("INVALID_NOTEBOOK", "Only canonical code and markdown cells are supported.")
        cell_id = cell["id"]
        if not isinstance(cell_id, str) or CELL_ID_RE.fullmatch(cell_id) is None or cell_id in cell_ids:
            raise ContractError("INVALID_NOTEBOOK", "Cell ids must be valid and unique.")
        cell_ids.add(cell_id)
        _validate_cell_metadata(cell["metadata"])
        source = cell["source"]
        if not isinstance(source, str):
            raise ContractError("INVALID_NOTEBOOK", "Cell source must be a canonical string.")
        source_bytes = len(source.encode("utf-8"))
        if source_bytes > MAX_CELL_SOURCE_BYTES:
            raise ContractError("INVALID_NOTEBOOK", "A cell source exceeds 64 KiB.")
        total_source_bytes += source_bytes
        if cell_type == "code" and (cell["execution_count"] is not None or cell["outputs"] != []):
            raise ContractError("INVALID_NOTEBOOK", "Input code cells must not contain prior execution state.")
    if total_source_bytes > MAX_TOTAL_SOURCE_BYTES:
        raise ContractError("INVALID_NOTEBOOK", "Notebook source exceeds 256 KiB in total.")
    return value


def validate_inert_json(
    value: Any,
    *,
    maximum_depth: int = 16,
    maximum_nodes: int = 10_000,
    maximum_string_bytes: int = 64 * 1024,
) -> Any:
    nodes = 0

    def visit(item: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > maximum_nodes or depth > maximum_depth:
            raise ContractError("INVALID_JSON_ARTIFACT", "JSON structure exceeds its safety limit.")
        if item is None or isinstance(item, bool):
            return
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            if isinstance(item, float) and not math.isfinite(item):
                raise ContractError("INVALID_JSON_ARTIFACT", "JSON numbers must be finite.")
            return
        if isinstance(item, str):
            if len(item.encode("utf-8")) > maximum_string_bytes:
                raise ContractError("INVALID_JSON_ARTIFACT", "JSON string exceeds its safety limit.")
            return
        if isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or len(key.encode("utf-8")) > maximum_string_bytes:
                    raise ContractError("INVALID_JSON_ARTIFACT", "JSON object key is invalid.")
                visit(child, depth + 1)
            return
        raise ContractError("INVALID_JSON_ARTIFACT", "JSON contains a non-JSON value.")

    visit(value, 0)
    return value


def canonical_json_bytes(value: Any) -> bytes:
    validate_inert_json(value)
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def load_job(input_dir: Path) -> tuple[JobManifest, dict[str, Any]]:
    if input_dir.is_symlink() or not input_dir.is_dir():
        raise ContractError("INVALID_INPUT", "Input directory must be a regular directory.")
    try:
        names = {entry.name for entry in input_dir.iterdir()}
    except OSError as error:
        raise ContractError("INVALID_INPUT", "Input directory could not be inspected.") from error
    if names != {"manifest.json", NOTEBOOK_FILENAME}:
        raise ContractError("INVALID_INPUT", "Input directory must contain exactly manifest.json and notebook.ipynb.")
    manifest = validate_manifest(parse_json_bytes(
        read_regular_file(input_dir / "manifest.json", maximum_bytes=MAX_MANIFEST_BYTES, code="INVALID_MANIFEST"),
        code="INVALID_MANIFEST",
        maximum_bytes=MAX_MANIFEST_BYTES,
    ))
    notebook = validate_notebook(parse_json_bytes(
        read_regular_file(input_dir / NOTEBOOK_FILENAME, maximum_bytes=MAX_NOTEBOOK_BYTES, code="INVALID_NOTEBOOK"),
        code="INVALID_NOTEBOOK",
        maximum_bytes=MAX_NOTEBOOK_BYTES,
    ))
    return manifest, notebook


Clock = Callable[[], float]
