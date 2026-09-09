"""State-preserving nbclient execution and bounded notebook output normalization."""

from __future__ import annotations

import base64
import copy
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .contract import ContractError, validate_inert_json
from .images import MAX_IMAGE_BYTES, canonicalize_image

MAX_OUTPUTS_PER_CELL = 128
MAX_TEXT_OUTPUT_BYTES = 512 * 1024
MAX_TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024
ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


@dataclass
class ExecutionFailure(Exception):
    code: str
    cell_index: int | None = None


class NotebookEngine(Protocol):
    def execute(self, notebook: dict[str, Any], *, workspace: Path, cell_timeout_seconds: int) -> dict[str, Any]: ...


class NbClientEngine:
    """The production adapter; imports the fixed Jupyter stack only when invoked."""

    def execute(self, notebook: dict[str, Any], *, workspace: Path, cell_timeout_seconds: int) -> dict[str, Any]:
        try:
            import nbformat
            from nbclient import NotebookClient
            from nbclient.exceptions import CellExecutionError, CellTimeoutError, DeadKernelError
        except ImportError as error:
            raise ExecutionFailure("RUNTIME_DEPENDENCY_MISSING") from error

        node = nbformat.from_dict(copy.deepcopy(notebook))
        try:
            nbformat.validate(node)
        except Exception as error:
            raise ExecutionFailure("INVALID_NOTEBOOK") from error
        active_cell: int | None = None

        # nbclient invokes hooks by keyword, so the parameter names are part of
        # its adapter contract (``cell`` and ``cell_index``).
        def on_cell_start(cell: Any, cell_index: int) -> None:
            nonlocal active_cell
            del cell
            active_cell = cell_index

        client = NotebookClient(
            node,
            timeout=cell_timeout_seconds,
            startup_timeout=10,
            kernel_name="python3",
            allow_errors=False,
            record_timing=False,
            resources={"metadata": {"path": str(workspace)}},
            on_cell_start=on_cell_start,
        )
        try:
            client.execute()
        except CellTimeoutError as error:
            raise ExecutionFailure("CELL_TIMEOUT", active_cell) from error
        except CellExecutionError as error:
            raise ExecutionFailure("CELL_EXECUTION_FAILED", active_cell) from error
        except DeadKernelError as error:
            raise ExecutionFailure("KERNEL_TERMINATED", active_cell) from error
        except Exception as error:
            raise ExecutionFailure("KERNEL_FAILED", active_cell) from error
        # nbformat.writes() deliberately splits multiline ``source`` strings
        # into line arrays. KFive's validated wire contract keeps source as a
        # string so the verifier can compare cell identity byte-for-byte.
        # A plain JSON round-trip removes NotebookNode wrappers without that
        # writer transformation; the sanitizer still validates every field.
        return json.loads(json.dumps(node, ensure_ascii=False))


def _bounded_text(value: Any, *, remaining: int) -> tuple[str, int]:
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        value = "".join(value)
    if not isinstance(value, str):
        raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook text output is malformed.")
    normalized = ANSI_ESCAPE_RE.sub("", value).replace("\x00", "")
    encoded = normalized.encode("utf-8")
    if len(encoded) > MAX_TEXT_OUTPUT_BYTES or len(encoded) > remaining:
        raise ContractError("NOTEBOOK_OUTPUT_LIMIT", "Notebook text output exceeds its byte limit.")
    return normalized, len(encoded)


def _sanitize_data_bundle(
    value: Any,
    *,
    remaining: int,
    image_canonicalizer: Any,
) -> tuple[dict[str, Any], int]:
    if not isinstance(value, dict):
        raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook display data is malformed.")
    cleaned: dict[str, Any] = {}
    consumed = 0
    if "text/plain" in value:
        text, size = _bounded_text(value["text/plain"], remaining=remaining - consumed)
        cleaned["text/plain"] = text
        consumed += size
    if "application/json" in value:
        structured = value["application/json"]
        validate_inert_json(structured)
        encoded = json.dumps(structured, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if len(encoded) > remaining - consumed:
            raise ContractError("NOTEBOOK_OUTPUT_LIMIT", "Notebook JSON output exceeds its byte limit.")
        cleaned["application/json"] = structured
        consumed += len(encoded)
    for mime_type, kind in (("image/png", "png"), ("image/jpeg", "jpeg")):
        if mime_type not in value:
            continue
        encoded_value = value[mime_type]
        if not isinstance(encoded_value, str) or len(encoded_value) > (MAX_IMAGE_BYTES * 4 // 3) + 8:
            raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook image output is malformed.")
        try:
            raw = base64.b64decode(encoded_value, validate=True)
        except (ValueError, base64.binascii.Error) as error:
            raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook image output is malformed.") from error
        canonical = image_canonicalizer(raw, kind)
        if len(canonical) > remaining - consumed:
            raise ContractError("NOTEBOOK_OUTPUT_LIMIT", "Notebook image output exceeds its byte limit.")
        cleaned[mime_type] = base64.b64encode(canonical).decode("ascii")
        consumed += len(canonical)
    return cleaned, consumed


def sanitize_executed_notebook(
    notebook: dict[str, Any],
    *,
    image_canonicalizer: Any = canonicalize_image,
) -> dict[str, Any]:
    cells = notebook.get("cells")
    if not isinstance(cells, list) or len(cells) > 32:
        raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Executed notebook cell list is malformed.")
    cleaned_cells: list[dict[str, Any]] = []
    total = 0
    for cell in cells:
        if not isinstance(cell, dict) or cell.get("cell_type") not in {"code", "markdown"}:
            raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Executed notebook cell is malformed.")
        base = {
            "cell_type": cell["cell_type"],
            "id": cell.get("id"),
            "metadata": {"tags": cell.get("metadata", {}).get("tags", [])} if cell.get("metadata", {}).get("tags") else {},
            "source": cell.get("source"),
        }
        if not isinstance(base["id"], str) or not isinstance(base["source"], str):
            raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Executed notebook identity fields are malformed.")
        if cell["cell_type"] == "markdown":
            cleaned_cells.append(base)
            continue
        execution_count = cell.get("execution_count")
        if execution_count is not None and (
            isinstance(execution_count, bool) or not isinstance(execution_count, int) or execution_count < 0
        ):
            raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Execution count is malformed.")
        outputs = cell.get("outputs")
        if not isinstance(outputs, list) or len(outputs) > MAX_OUTPUTS_PER_CELL:
            raise ContractError("NOTEBOOK_OUTPUT_LIMIT", "A cell produced too many outputs.")
        cleaned_outputs: list[dict[str, Any]] = []
        for output in outputs:
            if not isinstance(output, dict):
                raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook output is malformed.")
            output_type = output.get("output_type")
            remaining = MAX_TOTAL_OUTPUT_BYTES - total
            if output_type == "stream":
                if output.get("name") not in {"stdout", "stderr"}:
                    raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook stream name is malformed.")
                text, size = _bounded_text(output.get("text"), remaining=remaining)
                cleaned_outputs.append({"output_type": "stream", "name": output["name"], "text": text})
                total += size
            elif output_type == "error":
                traceback = output.get("traceback", [])
                if not isinstance(traceback, list) or len(traceback) > 64 or not all(isinstance(line, str) for line in traceback):
                    raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook error output is malformed.")
                text, size = _bounded_text("\n".join(traceback), remaining=remaining)
                cleaned_outputs.append({
                    "output_type": "error",
                    "ename": "CellExecutionError",
                    "evalue": "Notebook cell execution failed.",
                    "traceback": text.splitlines(),
                })
                total += size
            elif output_type in {"display_data", "execute_result"}:
                data, size = _sanitize_data_bundle(
                    output.get("data"), remaining=remaining, image_canonicalizer=image_canonicalizer
                )
                if data:
                    cleaned_output: dict[str, Any] = {"output_type": output_type, "data": data, "metadata": {}}
                    if output_type == "execute_result":
                        cleaned_output["execution_count"] = execution_count
                    cleaned_outputs.append(cleaned_output)
                    total += size
            else:
                raise ContractError("INVALID_NOTEBOOK_OUTPUT", "Notebook output type is unsupported.")
            if total > MAX_TOTAL_OUTPUT_BYTES:
                raise ContractError("NOTEBOOK_OUTPUT_LIMIT", "Notebook outputs exceed their total byte limit.")
        base.update({"execution_count": execution_count, "outputs": cleaned_outputs})
        cleaned_cells.append(base)
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "cells": cleaned_cells,
    }


__all__ = ["ExecutionFailure", "NbClientEngine", "NotebookEngine", "sanitize_executed_notebook"]
