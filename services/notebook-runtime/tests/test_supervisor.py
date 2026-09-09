from __future__ import annotations

import copy
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import kfive_runtime
from kfive_notebook_runtime.executor import ExecutionFailure
from kfive_notebook_runtime.supervisor import execute_job, main
from tests.helpers import code_cell, notebook, write_job


class SuccessEngine:
    def execute(self, value: dict, *, workspace: Path, cell_timeout_seconds: int) -> dict:
        self.timeout = cell_timeout_seconds
        self.sources = [cell["source"] for cell in value["cells"]]
        kfive_runtime.log_metric("accuracy", 0.875, step=4)
        artifacts = workspace / "artifacts"
        artifacts.mkdir()
        (artifacts / "summary.txt").write_bytes(b"ok\r\n")
        result = copy.deepcopy(value)
        for index, cell in enumerate(result["cells"], start=1):
            if cell["cell_type"] == "code":
                cell["execution_count"] = index
                cell["outputs"] = [{"output_type": "stream", "name": "stdout", "text": f"cell-{index}\n"}]
        return result


class FailureEngine:
    def __init__(self, code: str = "CELL_EXECUTION_FAILED", index: int | None = 1):
        self.code = code
        self.index = index

    def execute(self, value: dict, *, workspace: Path, cell_timeout_seconds: int) -> dict:
        raise ExecutionFailure(self.code, self.index)


class SupervisorTests(unittest.TestCase):
    def paths(self, root: Path) -> tuple[Path, Path, Path]:
        return root / "input", root / "output", root / "workspace"

    def test_success_writes_normalized_manifest_notebook_metrics_and_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_dir, output_dir, workspace = self.paths(Path(directory))
            write_job(input_dir, job_notebook=notebook([
                code_cell(source="value = 1", cell_id="a"),
                code_cell(source="print(value)", cell_id="b"),
            ]))
            engine = SuccessEngine()
            times = iter([1_700_000_000.0, 1_700_000_000.125])
            result = execute_job(input_dir, output_dir, workspace, engine=engine, clock=lambda: next(times))

            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["durationMs"], 125)
            self.assertEqual(result["notebookFile"], "executed.ipynb")
            self.assertEqual(result["metrics"], [{"name": "accuracy", "value": 0.875, "step": 4}])
            self.assertEqual(result["artifacts"][0]["path"], "artifacts/summary.txt")
            self.assertEqual((output_dir / "artifacts/summary.txt").read_bytes(), b"ok\n")
            self.assertEqual(json.loads((output_dir / "result.json").read_text()), result)
            executed = json.loads((output_dir / "executed.ipynb").read_text())
            self.assertEqual(executed["cells"][1]["outputs"][0]["text"], "cell-2\n")
            self.assertEqual(engine.timeout, 10)
            self.assertEqual(engine.sources, ["value = 1", "print(value)"])
            self.assertNotIn("KFIVE_METRIC_FILE", os.environ)

    def test_execution_failure_is_fixed_safe_and_has_cell_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_dir, output_dir, workspace = self.paths(Path(directory))
            write_job(input_dir)
            result = execute_job(input_dir, output_dir, workspace, engine=FailureEngine())
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["runId"], "run-1")
            self.assertEqual(result["error"], {
                "code": "CELL_EXECUTION_FAILED",
                "message": "Notebook cell execution failed.",
                "cellIndex": 1,
            })
            self.assertIsNone(result["notebookFile"])
            self.assertFalse((output_dir / "executed.ipynb").exists())

    def test_invalid_manifest_still_writes_safe_result_with_null_run_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_dir, output_dir, workspace = self.paths(Path(directory))
            write_job(input_dir)
            (input_dir / "manifest.json").write_text('{"schemaVersion":"wrong"}')
            result = execute_job(input_dir, output_dir, workspace, engine=SuccessEngine())
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["runId"])
            self.assertEqual(result["error"]["code"], "INVALID_MANIFEST")
            self.assertNotIn("wrong", result["error"]["message"])

    def test_unexpected_engine_error_is_redacted(self) -> None:
        class SecretEngine:
            def execute(self, value: dict, *, workspace: Path, cell_timeout_seconds: int) -> dict:
                raise RuntimeError("secret host path /home/user/token")

        with tempfile.TemporaryDirectory() as directory:
            input_dir, output_dir, workspace = self.paths(Path(directory))
            write_job(input_dir)
            result = execute_job(input_dir, output_dir, workspace, engine=SecretEngine())
            self.assertEqual(result["error"]["code"], "INTERNAL_ERROR")
            self.assertNotIn("secret", json.dumps(result))

    def test_refuses_nonempty_output_and_workspace_before_execution(self) -> None:
        for target_name in ("output", "workspace"):
            with self.subTest(target=target_name), tempfile.TemporaryDirectory() as directory:
                input_dir, output_dir, workspace = self.paths(Path(directory))
                write_job(input_dir)
                target = output_dir if target_name == "output" else workspace
                target.mkdir()
                (target / "existing").write_text("preserve")
                with self.assertRaisesRegex(Exception, "empty"):
                    execute_job(input_dir, output_dir, workspace, engine=SuccessEngine())
                self.assertEqual((target / "existing").read_text(), "preserve")

    def test_detects_output_directory_tampering_by_notebook(self) -> None:
        class TamperingEngine:
            def __init__(self, output: Path):
                self.output = output

            def execute(self, value: dict, *, workspace: Path, cell_timeout_seconds: int) -> dict:
                self.output.mkdir(exist_ok=True)
                (self.output / "forged-result.json").write_text("forged")
                return value

        with tempfile.TemporaryDirectory() as directory:
            input_dir, output_dir, workspace = self.paths(Path(directory))
            write_job(input_dir)
            result = execute_job(input_dir, output_dir, workspace, engine=TamperingEngine(output_dir))
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error"]["code"], "OUTPUT_TAMPERED")

    def test_cli_exit_codes_follow_result_status(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_dir, output_dir, workspace = self.paths(Path(directory))
            write_job(input_dir)
            with patch("kfive_notebook_runtime.supervisor.NbClientEngine", lambda: FailureEngine()):
                exit_code = main([
                    "--input-dir", str(input_dir), "--output-dir", str(output_dir), "--workspace-dir", str(workspace)
                ])
            self.assertEqual(exit_code, 1)
            self.assertTrue((output_dir / "result.json").exists())


@unittest.skipUnless(
    importlib.util.find_spec("nbclient") is not None and importlib.util.find_spec("nbformat") is not None,
    "nbclient/nbformat are installed only in the runtime image",
)
class ActualSupervisorTests(unittest.TestCase):
    def test_real_kernel_runs_inside_supervisor_workspace_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); input_dir = root / "input"; output_dir = root / "output"; workspace = root / "workspace"
            write_job(input_dir, job_notebook=notebook([
                code_cell(source="value = 40", cell_id="state-1"),
                code_cell(source="print(value + 2)", cell_id="state-2"),
            ]))
            result = execute_job(input_dir, output_dir, workspace)
            self.assertEqual(result["status"], "succeeded")
            executed = json.loads((output_dir / "executed.ipynb").read_text())
            self.assertEqual(executed["cells"][1]["outputs"][0]["text"], "42\n")
            self.assertTrue((workspace / ".jupyter" / "runtime").is_dir())


if __name__ == "__main__":
    unittest.main()
