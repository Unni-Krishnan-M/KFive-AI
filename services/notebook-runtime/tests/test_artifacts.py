from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from kfive_notebook_runtime.artifacts import (
    MAX_ARTIFACTS,
    MAX_ARTIFACT_BYTES,
    collect_artifacts,
    read_metrics,
)
from kfive_notebook_runtime.contract import ContractError


class ArtifactTests(unittest.TestCase):
    def roots(self, directory: str) -> tuple[Path, Path, Path]:
        root = Path(directory)
        workspace = root / "work"
        artifacts = workspace / "artifacts"
        output = root / "output"
        artifacts.mkdir(parents=True)
        output.mkdir()
        return workspace, artifacts, output

    def test_exports_sorted_canonical_text_and_json_with_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, artifacts, output = self.roots(directory)
            (artifacts / "z.txt").write_bytes(b"line1\r\nline2\r")
            nested = artifacts / "nested"
            nested.mkdir()
            (nested / "a.json").write_text('{"z":2,"a":1}', encoding="utf-8")

            records = collect_artifacts(workspace, output)

            self.assertEqual([record["path"] for record in records], ["artifacts/nested/a.json", "artifacts/z.txt"])
            json_bytes = b'{"a":1,"z":2}\n'
            self.assertEqual((output / "artifacts/nested/a.json").read_bytes(), json_bytes)
            self.assertEqual(records[0]["sha256"], hashlib.sha256(json_bytes).hexdigest())
            self.assertEqual((output / "artifacts/z.txt").read_bytes(), b"line1\nline2\n")

    def test_exports_images_only_after_canonicalization(self) -> None:
        calls: list[tuple[bytes, str]] = []

        def canonicalizer(data: bytes, kind: str) -> bytes:
            calls.append((data, kind))
            return b"canonical-" + kind.encode()

        with tempfile.TemporaryDirectory() as directory:
            workspace, artifacts, output = self.roots(directory)
            (artifacts / "plot.png").write_bytes(b"untrusted")
            (artifacts / "photo.jpeg").write_bytes(b"untrusted-jpeg")
            records = collect_artifacts(workspace, output, image_canonicalizer=canonicalizer)
            self.assertEqual(calls, [(b"untrusted-jpeg", "jpeg"), (b"untrusted", "png")])
            self.assertEqual([record["kind"] for record in records], ["jpeg", "png"])
            self.assertEqual((output / "artifacts/plot.png").read_bytes(), b"canonical-png")

    def test_rejects_unknown_extension_invalid_utf8_and_duplicate_json_keys(self) -> None:
        cases = [("bad.html", b"<script>"), ("bad.txt", b"\xff"), ("bad.json", b'{"x":1,"x":2}')]
        for filename, content in cases:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as directory:
                workspace, artifacts, output = self.roots(directory)
                (artifacts / filename).write_bytes(content)
                with self.assertRaises(ContractError):
                    collect_artifacts(workspace, output)
                self.assertEqual(list(output.iterdir()), [])

    def test_rejects_symlinked_directory_file_and_hardlink(self) -> None:
        for kind in ("directory", "file", "hardlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                workspace, artifacts, output = self.roots(directory)
                outside = root / "outside.txt"
                outside.write_text("secret")
                if kind == "directory":
                    (artifacts / "link").symlink_to(root, target_is_directory=True)
                elif kind == "file":
                    (artifacts / "link.txt").symlink_to(outside)
                else:
                    os.link(outside, artifacts / "hard.txt")
                with self.assertRaisesRegex(ContractError, "Artifact"):
                    collect_artifacts(workspace, output)

    def test_rejects_hidden_unsafe_deep_and_long_paths(self) -> None:
        names = [".hidden.txt", "bad name.txt", f"{'a' * 65}.txt"]
        for name in names:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                workspace, artifacts, output = self.roots(directory)
                (artifacts / name).write_text("x")
                with self.assertRaisesRegex(ContractError, "portable"):
                    collect_artifacts(workspace, output)

    def test_rejects_count_per_file_and_total_limits_before_copying(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, artifacts, output = self.roots(directory)
            for index in range(MAX_ARTIFACTS + 1):
                (artifacts / f"f{index}.txt").write_text("x")
            with self.assertRaisesRegex(ContractError, "At most"):
                collect_artifacts(workspace, output)
            self.assertEqual(list(output.iterdir()), [])
        with tempfile.TemporaryDirectory() as directory:
            workspace, artifacts, output = self.roots(directory)
            (artifacts / "large.txt").write_bytes(b"x" * (MAX_ARTIFACT_BYTES + 1))
            with self.assertRaisesRegex(ContractError, "byte limit"):
                collect_artifacts(workspace, output)

    def test_refuses_output_collision_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, artifacts, output = self.roots(directory)
            (artifacts / "safe.txt").write_text("new")
            target = output / "artifacts"
            target.mkdir()
            (target / "safe.txt").write_text("existing")
            with self.assertRaisesRegex(ContractError, "exists"):
                collect_artifacts(workspace, output)
            self.assertEqual((target / "safe.txt").read_text(), "existing")

    def test_missing_artifact_directory_is_empty_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace, output = root / "work", root / "output"
            workspace.mkdir()
            output.mkdir()
            self.assertEqual(collect_artifacts(workspace, output), [])


class MetricReaderTests(unittest.TestCase):
    def metric_path(self, root: Path) -> Path:
        path = root / "work/.kfive/metrics.jsonl"
        path.parent.mkdir(parents=True)
        return path

    def test_reads_exact_normalized_finite_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.metric_path(root)
            path.write_text('{"name":"loss","value":1,"step":0}\n{"name":"accuracy","value":0.5,"step":null}\n')
            self.assertEqual(read_metrics(root / "work"), [
                {"name": "loss", "value": 1.0, "step": 0},
                {"name": "accuracy", "value": 0.5, "step": None},
            ])

    def test_rejects_bad_keys_names_values_steps_and_duplicates(self) -> None:
        lines = [
            '{"name":"x","value":1,"step":null,"extra":1}',
            '{"name":"bad name","value":1,"step":null}',
            '{"name":"x","value":true,"step":null}',
            '{"name":"x","value":1,"step":-1}',
            '{"name":"x","name":"y","value":1,"step":null}',
        ]
        for line in lines:
            with self.subTest(line=line), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.metric_path(root).write_text(line + "\n")
                with self.assertRaises(ContractError):
                    read_metrics(root / "work")

    def test_rejects_symlinked_metric_stream(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.write_text('{"name":"x","value":1,"step":null}\n')
            path = self.metric_path(root)
            path.unlink(missing_ok=True)
            path.symlink_to(real)
            with self.assertRaises(ContractError):
                read_metrics(root / "work")

    def test_missing_metrics_is_empty_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(read_metrics(Path(directory)), [])


if __name__ == "__main__":
    unittest.main()
