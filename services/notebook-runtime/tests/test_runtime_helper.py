from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import kfive_runtime


class MetricHelperTests(unittest.TestCase):
    def test_writes_exact_jsonl_contract_and_creates_private_parent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private/metrics.jsonl"
            with patch.dict(os.environ, {"KFIVE_METRIC_FILE": str(path)}):
                kfive_runtime.log_metric("loss", 1, step=0)
                kfive_runtime.log_metric("accuracy", 0.75)
            lines = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(lines, [
                {"name": "loss", "value": 1.0, "step": 0},
                {"name": "accuracy", "value": 0.75, "step": None},
            ])
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_rejects_invalid_names_nonfinite_bool_values_and_steps(self) -> None:
        cases = [
            ("bad name", 1, None),
            ("loss", float("nan"), None),
            ("loss", True, None),
            ("loss", 1, True),
            ("loss", 1, -1),
        ]
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"KFIVE_METRIC_FILE": str(Path(directory) / "metrics")}
        ):
            for name, value, step in cases:
                with self.subTest(name=name, value=value, step=step), self.assertRaises(ValueError):
                    kfive_runtime.log_metric(name, value, step)  # type: ignore[arg-type]

    def test_requires_supervisor_configuration(self) -> None:
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, "not configured"):
            kfive_runtime.log_metric("loss", 1)

    def test_enforces_count_and_file_limits_before_append(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics"
            path.write_text("{}\n" * 2)
            with patch.dict(os.environ, {"KFIVE_METRIC_FILE": str(path)}), patch.object(kfive_runtime, "_MAX_METRICS", 2):
                with self.assertRaisesRegex(RuntimeError, "count"):
                    kfive_runtime.log_metric("loss", 1)
            path.write_bytes(b"x" * 10)
            with patch.dict(os.environ, {"KFIVE_METRIC_FILE": str(path)}), patch.object(kfive_runtime, "_MAX_FILE_BYTES", 10):
                with self.assertRaisesRegex(RuntimeError, "output"):
                    kfive_runtime.log_metric("loss", 1)


if __name__ == "__main__":
    unittest.main()
