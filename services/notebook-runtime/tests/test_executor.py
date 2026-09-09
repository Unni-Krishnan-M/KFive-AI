from __future__ import annotations

import base64
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path

from kfive_notebook_runtime.contract import ContractError
from kfive_notebook_runtime.executor import NbClientEngine, sanitize_executed_notebook
from tests.helpers import code_cell, markdown_cell, notebook


def executed_notebook(outputs: list[dict] | None = None) -> dict:
    value = notebook([markdown_cell(), code_cell(source="print('ok')")])
    value["cells"][1]["execution_count"] = 1
    value["cells"][1]["outputs"] = outputs or []
    return value


class SanitizerTests(unittest.TestCase):
    def test_keeps_bounded_stream_and_strips_ansi_nul(self) -> None:
        value = executed_notebook([{"output_type": "stream", "name": "stdout", "text": "\x1b[31mred\x1b[0m\x00\n"}])
        cleaned = sanitize_executed_notebook(value)
        self.assertEqual(cleaned["cells"][1]["outputs"], [
            {"output_type": "stream", "name": "stdout", "text": "red\n"}
        ])
        self.assertEqual(cleaned["nbformat_minor"], 5)
        self.assertEqual(cleaned["metadata"]["kernelspec"]["name"], "python3")

    def test_accepts_list_form_stream_text_but_emits_canonical_string(self) -> None:
        value = executed_notebook([{"output_type": "stream", "name": "stderr", "text": ["one", "two"]}])
        cleaned = sanitize_executed_notebook(value)
        self.assertEqual(cleaned["cells"][1]["outputs"][0]["text"], "onetwo")

    def test_redacts_user_controlled_error_name_and_value(self) -> None:
        value = executed_notebook([{
            "output_type": "error",
            "ename": "<script>",
            "evalue": "secret path /host",
            "traceback": ["Traceback", "\x1b[31mValueError\x1b[0m"],
        }])
        cleaned = sanitize_executed_notebook(value)
        output = cleaned["cells"][1]["outputs"][0]
        self.assertEqual(output["ename"], "CellExecutionError")
        self.assertEqual(output["evalue"], "Notebook cell execution failed.")
        self.assertEqual(output["traceback"], ["Traceback", "ValueError"])

    def test_keeps_only_allowlisted_mime_data_and_canonicalizes_images(self) -> None:
        calls: list[tuple[bytes, str]] = []

        def image_cleaner(data: bytes, kind: str) -> bytes:
            calls.append((data, kind))
            return b"clean"

        value = executed_notebook([{
            "output_type": "display_data",
            "metadata": {"untrusted": "value"},
            "data": {
                "text/plain": "figure",
                "text/html": "<script>alert(1)</script>",
                "application/javascript": "alert(1)",
                "image/png": base64.b64encode(b"raw").decode(),
            },
        }])
        output = sanitize_executed_notebook(value, image_canonicalizer=image_cleaner)["cells"][1]["outputs"][0]
        self.assertEqual(calls, [(b"raw", "png")])
        self.assertEqual(output["metadata"], {})
        self.assertEqual(set(output["data"]), {"text/plain", "image/png"})
        self.assertEqual(base64.b64decode(output["data"]["image/png"]), b"clean")

    def test_keeps_inert_json_and_execute_result_count(self) -> None:
        value = executed_notebook([{
            "output_type": "execute_result",
            "execution_count": 999,
            "metadata": {},
            "data": {"application/json": {"result": [1, True, None]}},
        }])
        output = sanitize_executed_notebook(value)["cells"][1]["outputs"][0]
        self.assertEqual(output["execution_count"], 1)
        self.assertEqual(output["data"]["application/json"], {"result": [1, True, None]})

    def test_drops_display_output_when_no_allowlisted_mime_remains(self) -> None:
        value = executed_notebook([{
            "output_type": "display_data", "metadata": {}, "data": {"text/html": "<b>only</b>"}
        }])
        self.assertEqual(sanitize_executed_notebook(value)["cells"][1]["outputs"], [])

    def test_rejects_unknown_output_type_stream_name_and_malformed_base64(self) -> None:
        cases = [
            {"output_type": "update_display_data", "data": {}, "metadata": {}},
            {"output_type": "stream", "name": "log", "text": "x"},
            {"output_type": "display_data", "metadata": {}, "data": {"image/png": "%%%"}},
        ]
        for output in cases:
            with self.subTest(output=output), self.assertRaises(ContractError):
                sanitize_executed_notebook(executed_notebook([output]), image_canonicalizer=lambda data, kind: data)

    def test_rejects_output_count_text_and_total_limits(self) -> None:
        too_many = [{"output_type": "stream", "name": "stdout", "text": "x"}] * 129
        with self.assertRaisesRegex(ContractError, "too many"):
            sanitize_executed_notebook(executed_notebook(too_many))
        with self.assertRaisesRegex(ContractError, "text output"):
            sanitize_executed_notebook(executed_notebook([
                {"output_type": "stream", "name": "stdout", "text": "x" * (512 * 1024 + 1)}
            ]))

    def test_rejects_malformed_execution_count_and_cell_identity(self) -> None:
        for mutation in ("count", "id", "source"):
            value = executed_notebook()
            if mutation == "count":
                value["cells"][1]["execution_count"] = True
            else:
                value["cells"][1][mutation] = None
            with self.subTest(mutation=mutation), self.assertRaises(ContractError):
                sanitize_executed_notebook(value)


@unittest.skipUnless(
    importlib.util.find_spec("nbclient") is not None and importlib.util.find_spec("nbformat") is not None,
    "nbclient/nbformat are installed only in the runtime image",
)
class ActualNbClientTests(unittest.TestCase):
    def test_preserves_python_state_across_cells(self) -> None:
        value = notebook([
            code_cell(source="value = 40", cell_id="state-1"),
            code_cell(source="print(value + 2)", cell_id="state-2"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            executed = NbClientEngine().execute(value, workspace=Path(directory), cell_timeout_seconds=10)
        output = sanitize_executed_notebook(executed)["cells"][1]["outputs"][0]
        self.assertEqual(output["output_type"], "stream")
        self.assertEqual(output["text"], "42\n")


if __name__ == "__main__":
    unittest.main()
