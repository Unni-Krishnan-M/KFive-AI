from __future__ import annotations

import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from kfive_notebook_runtime.contract import ContractError
from kfive_notebook_runtime.preload import SCHEMA, decode_envelope, populate


def envelope(files: list[tuple[str, bytes]]) -> bytes:
    return json.dumps({
        "schemaVersion": SCHEMA,
        "files": [{
            "path": path,
            "data": base64.b64encode(data).decode("ascii"),
            "sha256": hashlib.sha256(data).hexdigest(),
        } for path, data in files],
    }).encode()


class PreloadTests(unittest.TestCase):
    def test_decodes_and_populates_nested_regular_read_only_files(self) -> None:
        files = decode_envelope(envelope([("manifest.json", b"{}\n"), ("artifacts/report.txt", b"safe")]))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            populate(root, files)
            self.assertEqual((root / "manifest.json").read_bytes(), b"{}\n")
            self.assertEqual((root / "artifacts/report.txt").read_bytes(), b"safe")
            self.assertEqual((root / "manifest.json").stat().st_mode & 0o777, 0o444)
            self.assertEqual((root / "artifacts").stat().st_mode & 0o777, 0o555)

    def test_rejects_hash_duplicate_path_traversal_hidden_and_unknown_keys(self) -> None:
        valid = json.loads(envelope([("safe.txt", b"safe")]))
        cases = []
        cases.append({**valid, "extra": True})
        cases.append({**valid, "files": [valid["files"][0], valid["files"][0]]})
        for path in ("../escape", "nested/../escape", ".hidden", "nested/.hidden"):
            changed = json.loads(json.dumps(valid)); changed["files"][0]["path"] = path; cases.append(changed)
        changed = json.loads(json.dumps(valid)); changed["files"][0]["sha256"] = "0" * 64; cases.append(changed)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ContractError):
                decode_envelope(json.dumps(value).encode())

    def test_rejects_nonempty_or_symlink_destination(self) -> None:
        files = decode_envelope(envelope([("safe.txt", b"safe")]))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "existing").write_text("x")
            with self.assertRaises(ContractError):
                populate(root, files)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); target = root / "target"; target.mkdir(); link = root / "link"; link.symlink_to(target)
            with self.assertRaises(ContractError):
                populate(link, files)


if __name__ == "__main__":
    unittest.main()
