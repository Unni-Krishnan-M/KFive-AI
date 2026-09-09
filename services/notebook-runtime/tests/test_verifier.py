from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

from kfive_notebook_runtime.supervisor import execute_job
from kfive_notebook_runtime.exporter import encode_directory
from kfive_notebook_runtime.preload import decode_envelope, populate
from kfive_notebook_runtime.verifier import VerificationError, main, verify_output
from tests.helpers import code_cell, notebook, write_job
from tests.test_supervisor import FailureEngine, SuccessEngine


class VerifierTests(unittest.TestCase):
    def successful_bundle(self, root: Path) -> tuple[Path, Path, Path]:
        input_dir, candidate, workspace, verified = root / "input", root / "candidate", root / "work", root / "verified"
        write_job(input_dir, job_notebook=notebook([code_cell(source="print('ok')", cell_id="cell-1")]))
        times = iter([1_700_000_000.0, 1_700_000_000.125])
        execute_job(input_dir, candidate, workspace, engine=SuccessEngine(), clock=lambda: next(times))
        return input_dir, candidate, verified

    def test_recreates_a_canonical_success_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_dir, candidate, verified = self.successful_bundle(Path(directory))
            result = verify_output(input_dir, candidate, verified, "run-1")
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual((verified / "artifacts/summary.txt").read_bytes(), b"ok\n")
            self.assertEqual(json.loads((verified / "executed.ipynb").read_text())["cells"][0]["id"], "cell-1")
            self.assertEqual(set(path.relative_to(verified).as_posix() for path in verified.rglob("*") if path.is_file()), {
                "result.json", "executed.ipynb", "artifacts/summary.txt",
            })

    def test_accepts_only_an_exact_redacted_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); input_dir = root / "input"; candidate = root / "candidate"; verified = root / "verified"
            write_job(input_dir)
            execute_job(input_dir, candidate, root / "work", engine=FailureEngine(index=0))
            self.assertEqual(verify_output(input_dir, candidate, verified, "run-1")["status"], "failed")
            self.assertEqual([path.name for path in verified.iterdir()], ["result.json"])

    def test_rejects_extra_forged_symlinked_and_hardlinked_files(self) -> None:
        for mutation in ("extra", "symlink", "hardlink"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                input_dir, candidate, verified = self.successful_bundle(Path(directory))
                if mutation == "extra":
                    (candidate / "forged.txt").write_text("secret")
                elif mutation == "symlink":
                    (candidate / "forged.txt").symlink_to(candidate / "result.json")
                else:
                    os.link(candidate / "result.json", candidate / "forged.txt")
                with self.assertRaises(VerificationError):
                    verify_output(input_dir, candidate, verified, "run-1")

    def test_rejects_changed_cell_identity_and_noncanonical_output(self) -> None:
        for mutation in ("source", "html"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                input_dir, candidate, verified = self.successful_bundle(Path(directory))
                executed_path = candidate / "executed.ipynb"
                executed = json.loads(executed_path.read_text())
                if mutation == "source":
                    executed["cells"][0]["source"] = "print('forged')"
                else:
                    executed["cells"][0]["outputs"].append({
                        "output_type": "display_data", "data": {"text/html": "<script>bad()</script>"}, "metadata": {},
                    })
                executed_path.write_text(json.dumps(executed))
                with self.assertRaises(VerificationError):
                    verify_output(input_dir, candidate, verified, "run-1")

    def test_rejects_artifact_hash_size_path_and_bytes_mismatch(self) -> None:
        for mutation in ("hash", "size", "path", "bytes"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                input_dir, candidate, verified = self.successful_bundle(Path(directory))
                result_path = candidate / "result.json"; result = json.loads(result_path.read_text())
                record = result["artifacts"][0]
                if mutation == "hash": record["sha256"] = "0" * 64
                elif mutation == "size": record["bytes"] += 1
                elif mutation == "path": record["path"] = "artifacts/../secret.txt"
                else:
                    artifact = candidate / record["path"]
                    artifact.write_bytes(b"changed\r\n")
                    record["bytes"] = len(artifact.read_bytes())
                    record["sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
                result_path.write_text(json.dumps(result))
                with self.assertRaises(VerificationError):
                    verify_output(input_dir, candidate, verified, "run-1")

    def test_rejects_wrong_run_id_dirty_destination_and_reports_safe_cli_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_dir, candidate, verified = self.successful_bundle(Path(directory))
            with self.assertRaises(VerificationError):
                verify_output(input_dir, candidate, verified, "other-run")
            verified.mkdir(exist_ok=True); (verified / "existing").write_text("preserve")
            self.assertEqual(main([
                "--input-dir", str(input_dir), "--candidate-dir", str(candidate),
                "--verified-dir", str(verified), "--run-id", "run-1",
            ]), 1)
            self.assertEqual((verified / "existing").read_text(), "preserve")


@unittest.skipUnless(
    importlib.util.find_spec("nbclient") is not None and importlib.util.find_spec("nbformat") is not None,
    "nbclient/nbformat are installed only in the runtime image",
)
class ActualTwoStagePipelineTests(unittest.TestCase):
    def test_real_kernel_bundle_survives_both_stream_transfers_and_verification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source_input = root / "source-input"; runtime_output = root / "runtime-output"
            write_job(source_input, job_notebook=notebook([
                code_cell(source="value = 40", cell_id="state-1"),
                code_cell(source="print(value + 2)", cell_id="state-2"),
            ]))
            runtime_input = root / "runtime-input"; runtime_input.mkdir()
            populate(runtime_input, decode_envelope(encode_directory(source_input)))
            self.assertEqual(execute_job(runtime_input, runtime_output, root / "workspace")["status"], "succeeded")

            verifier_input = root / "verifier-input"; verifier_candidate = root / "verifier-candidate"
            verifier_input.mkdir(); verifier_candidate.mkdir()
            populate(verifier_input, decode_envelope(encode_directory(source_input)))
            populate(verifier_candidate, decode_envelope(encode_directory(runtime_output)))
            verified = root / "verified"
            result = verify_output(verifier_input, verifier_candidate, verified, "run-1")
            self.assertEqual(result["status"], "succeeded")
            executed = json.loads((verified / "executed.ipynb").read_text())
            self.assertEqual(executed["cells"][1]["outputs"][0]["text"], "42\n")


if __name__ == "__main__":
    unittest.main()
