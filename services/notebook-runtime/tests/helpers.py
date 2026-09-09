from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


def code_cell(source: str = "value = 1", cell_id: str = "code-1") -> dict[str, Any]:
    return {
        "cell_type": "code",
        "id": cell_id,
        "metadata": {},
        "source": source,
        "execution_count": None,
        "outputs": [],
    }


def markdown_cell(source: str = "# Example", cell_id: str = "markdown-1") -> dict[str, Any]:
    return {"cell_type": "markdown", "id": cell_id, "metadata": {}, "source": source}


def notebook(cells: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.12"},
        },
        "cells": copy.deepcopy(cells if cells is not None else [code_cell()]),
    }


def manifest(run_id: str = "run-1", timeout: int = 10) -> dict[str, Any]:
    return {
        "schemaVersion": "kfive.notebook-job.v1",
        "runId": run_id,
        "notebookFile": "notebook.ipynb",
        "cellTimeoutSeconds": timeout,
    }


def write_job(path: Path, *, job_manifest: dict[str, Any] | None = None, job_notebook: dict[str, Any] | None = None) -> None:
    path.mkdir(parents=True)
    (path / "manifest.json").write_text(json.dumps(job_manifest or manifest()), encoding="utf-8")
    (path / "notebook.ipynb").write_text(json.dumps(job_notebook or notebook()), encoding="utf-8")

