from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from kfive_notebook_runtime.contract import ContractError
from kfive_notebook_runtime.exporter import encode_directory
from kfive_notebook_runtime.preload import decode_envelope


class ExporterTests(unittest.TestCase):
    def test_exports_a_sorted_round_trip_envelope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "artifacts").mkdir()
            (root / "result.json").write_bytes(b"{}\n")
            (root / "artifacts" / "report.txt").write_bytes(b"safe")
            exported = encode_directory(root)
            self.assertEqual(
                decode_envelope(exported),
                [("artifacts/report.txt", b"safe"), ("result.json", b"{}\n")],
            )
            self.assertEqual(json.loads(exported)["schemaVersion"], "kfive.notebook-files.v1")

    def test_rejects_empty_hidden_symlink_and_hardlink_exports(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ContractError):
                encode_directory(Path(directory))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / ".hidden").write_text("x")
            with self.assertRaises(ContractError):
                encode_directory(root)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "target.txt").write_text("x"); (root / "link.txt").symlink_to("target.txt")
            with self.assertRaises(ContractError):
                encode_directory(root)
        if hasattr(os, "link"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory); (root / "one.txt").write_text("x"); os.link(root / "one.txt", root / "two.txt")
                with self.assertRaises(ContractError):
                    encode_directory(root)


if __name__ == "__main__":
    unittest.main()
