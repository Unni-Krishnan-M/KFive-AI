from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from kfive_notebook_runtime.contract import (
    ContractError,
    MAX_CELL_SOURCE_BYTES,
    MAX_CELLS,
    MAX_NOTEBOOK_BYTES,
    JobManifest,
    canonical_json_bytes,
    load_job,
    parse_json_bytes,
    validate_inert_json,
    validate_manifest,
    validate_notebook,
)
from tests.helpers import code_cell, manifest, markdown_cell, notebook, write_job


class ManifestTests(unittest.TestCase):
    def test_accepts_exact_manifest(self) -> None:
        self.assertEqual(validate_manifest(manifest()), JobManifest("run-1", 10))

    def test_rejects_unknown_missing_and_wrong_schema_keys(self) -> None:
        for value in (
            {**manifest(), "extra": True},
            {key: value for key, value in manifest().items() if key != "runId"},
            {**manifest(), "schemaVersion": "v2"},
        ):
            with self.subTest(value=value), self.assertRaisesRegex(ContractError, "Manifest"):
                validate_manifest(value)

    def test_rejects_run_id_path_and_control_characters(self) -> None:
        for run_id in ("", "../escape", "space value", "a" * 65, "line\nbreak"):
            with self.subTest(run_id=run_id), self.assertRaises(ContractError):
                validate_manifest(manifest(run_id=run_id))

    def test_rejects_boolean_and_out_of_range_timeouts(self) -> None:
        for timeout in (True, 0, 31, 1.5, "10"):
            with self.subTest(timeout=timeout), self.assertRaises(ContractError):
                validate_manifest(manifest(timeout=timeout))  # type: ignore[arg-type]

    def test_notebook_filename_is_not_selectable(self) -> None:
        with self.assertRaisesRegex(ContractError, "notebook.ipynb"):
            validate_manifest({**manifest(), "notebookFile": "other.ipynb"})


class JsonTests(unittest.TestCase):
    def test_rejects_duplicate_keys_non_finite_constants_and_invalid_utf8(self) -> None:
        for value in (b'{"a":1,"a":2}', b'{"a":NaN}', b"\xff"):
            with self.subTest(value=value), self.assertRaises(ContractError):
                parse_json_bytes(value, code="INVALID", maximum_bytes=100)

    def test_byte_limit_is_utf8_bytes(self) -> None:
        with self.assertRaisesRegex(ContractError, "byte limit"):
            parse_json_bytes('"€"'.encode(), code="INVALID", maximum_bytes=4)

    def test_inert_json_accepts_json_and_rejects_nonfinite_or_excessive_depth(self) -> None:
        value = {"ok": [None, True, 1, 2.5, "text"]}
        self.assertIs(validate_inert_json(value), value)
        with self.assertRaises(ContractError):
            validate_inert_json(float("inf"))
        with self.assertRaises(ContractError):
            validate_inert_json([[[1]]], maximum_depth=1)

    def test_canonical_json_is_sorted_finite_utf8_with_newline(self) -> None:
        self.assertEqual(canonical_json_bytes({"z": "é", "a": 1}), b'{"a":1,"z":"\xc3\xa9"}\n')


class NotebookTests(unittest.TestCase):
    def test_accepts_code_and_markdown_with_safe_unique_tags(self) -> None:
        value = notebook([code_cell(), markdown_cell()])
        value["cells"][0]["metadata"] = {"tags": ["training", "fold:1"]}
        self.assertIs(validate_notebook(value), value)

    def test_requires_canonical_top_level_and_supported_version(self) -> None:
        cases = [
            {**notebook(), "unknown": 1},
            {**notebook(), "nbformat": 3},
            {**notebook(), "nbformat_minor": 6},
            {**notebook(), "nbformat_minor": True},
        ]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ContractError):
                validate_notebook(value)

    def test_requires_one_through_32_cells(self) -> None:
        for cells in ([], [code_cell(cell_id=f"c-{index}") for index in range(MAX_CELLS + 1)]):
            with self.subTest(count=len(cells)), self.assertRaises(ContractError):
                validate_notebook(notebook(cells))

    def test_rejects_raw_unknown_and_noncanonical_cells(self) -> None:
        raw = {"cell_type": "raw", "id": "raw", "metadata": {}, "source": "x"}
        code_with_attachment = {**code_cell(), "attachments": {}}
        for cell in (raw, code_with_attachment):
            with self.subTest(cell=cell), self.assertRaises(ContractError):
                validate_notebook(notebook([cell]))

    def test_rejects_preexecuted_cells(self) -> None:
        for changes in ({"execution_count": 1}, {"outputs": [{"output_type": "stream"}]}):
            cell = {**code_cell(), **changes}
            with self.subTest(changes=changes), self.assertRaisesRegex(ContractError, "prior execution"):
                validate_notebook(notebook([cell]))

    def test_rejects_duplicate_or_unsafe_cell_ids(self) -> None:
        with self.assertRaises(ContractError):
            validate_notebook(notebook([code_cell(cell_id="same"), markdown_cell(cell_id="same")]))
        with self.assertRaises(ContractError):
            validate_notebook(notebook([code_cell(cell_id="../bad")]))

    def test_rejects_non_string_and_utf8_oversize_source(self) -> None:
        invalid_type = code_cell()
        invalid_type["source"] = ["print(1)"]
        with self.assertRaises(ContractError):
            validate_notebook(notebook([invalid_type]))
        with self.assertRaisesRegex(ContractError, "64 KiB"):
            validate_notebook(notebook([code_cell(source="€" * ((MAX_CELL_SOURCE_BYTES // 3) + 1))]))

    def test_rejects_total_source_limit(self) -> None:
        cells = [code_cell(source="x" * (MAX_CELL_SOURCE_BYTES - 1), cell_id=f"c-{index}") for index in range(5)]
        with self.assertRaisesRegex(ContractError, "256 KiB"):
            validate_notebook(notebook(cells))

    def test_rejects_non_python_kernel_and_unbounded_metadata(self) -> None:
        wrong_kernel = notebook()
        wrong_kernel["metadata"]["kernelspec"]["name"] = "bash"
        with self.assertRaisesRegex(ContractError, "Python 3"):
            validate_notebook(wrong_kernel)
        unknown_metadata = notebook()
        unknown_metadata["metadata"]["widgets"] = {}
        with self.assertRaises(ContractError):
            validate_notebook(unknown_metadata)

    def test_rejects_duplicate_or_unsafe_tags(self) -> None:
        for tags in (["same", "same"], ["bad tag"], ["x"] * 17):
            cell = code_cell()
            cell["metadata"] = {"tags": tags}
            with self.subTest(tags=tags), self.assertRaises(ContractError):
                validate_notebook(notebook([cell]))


class JobDirectoryTests(unittest.TestCase):
    def test_loads_exact_regular_job_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            write_job(path)
            loaded_manifest, loaded_notebook = load_job(path)
            self.assertEqual(loaded_manifest.run_id, "run-1")
            self.assertEqual(loaded_notebook["cells"][0]["id"], "code-1")

    def test_rejects_extra_files_and_symlinked_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "input"
            write_job(path)
            (path / "extra").write_text("x")
            with self.assertRaisesRegex(ContractError, "exactly"):
                load_job(path)
            (path / "extra").unlink()
            (path / "notebook.ipynb").unlink()
            target = root / "real.ipynb"
            target.write_text(json.dumps(notebook()))
            (path / "notebook.ipynb").symlink_to(target)
            with self.assertRaisesRegex(ContractError, "non-symlink"):
                load_job(path)

    def test_rejects_oversize_notebook_before_json_parsing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            write_job(path)
            (path / "notebook.ipynb").write_bytes(b" " * (MAX_NOTEBOOK_BYTES + 1))
            with self.assertRaisesRegex(ContractError, "byte limit"):
                load_job(path)


if __name__ == "__main__":
    unittest.main()
