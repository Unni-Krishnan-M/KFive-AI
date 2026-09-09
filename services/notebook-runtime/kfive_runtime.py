"""Small helper deliberately exposed to executed KFive notebook cells."""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path

_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_MAX_METRICS = 1000
_MAX_FILE_BYTES = 128 * 1024


def _metric_file() -> Path:
    configured = os.environ.get("KFIVE_METRIC_FILE")
    if not configured:
        raise RuntimeError("KFive metric output is not configured.")
    return Path(configured)


def log_metric(name: str, value: int | float, step: int | None = None) -> None:
    """Append one finite scalar metric to this run's supervisor-owned stream."""
    if not isinstance(name, str) or _NAME_RE.fullmatch(name) is None:
        raise ValueError("Metric name is invalid.")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError("Metric value must be a finite number.")
    if step is not None and (
        isinstance(step, bool) or not isinstance(step, int) or not 0 <= step <= 2_147_483_647
    ):
        raise ValueError("Metric step must be a non-negative integer or None.")
    target = _metric_file()
    try:
        stat = target.stat()
        if stat.st_size >= _MAX_FILE_BYTES:
            raise RuntimeError("Metric output limit reached.")
        with target.open("r", encoding="utf-8") as existing:
            if sum(1 for _ in existing) >= _MAX_METRICS:
                raise RuntimeError("Metric count limit reached.")
    except FileNotFoundError:
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"name": name, "value": float(value), "step": step}
    encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"
    if len(encoded.encode("utf-8")) > 256:
        raise RuntimeError("Metric record exceeds its safety limit.")
    with target.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(encoded)


__all__ = ["log_metric"]
