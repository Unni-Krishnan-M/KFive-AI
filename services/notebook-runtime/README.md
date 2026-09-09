# KFive notebook runtime

This directory contains a one-shot Python notebook supervisor intended to be started in a fresh disposable container for every run. It is not a Jupyter server and opens no port. The image exposes one fixed Python 3.12 environment with NumPy, pandas, SciPy, scikit-learn, Matplotlib and joblib. There is no request field for a kernel, shell, image, command, package, or dependency. `pip` is removed from the final virtual environment; the non-root user cannot modify the fixed environment.

The image is one layer of the isolation design, not the security boundary. The broker must run it with networking disabled, a read-only root filesystem, a read-only input mount, a fresh output mount, tmpfs workspace, non-root execution, all capabilities dropped, `no-new-privileges`, a restrictive seccomp/AppArmor profile, and explicit CPU, memory, PID, temporary-storage and wall-clock limits. Python can invoke native APIs; do not run this process directly on the host and do not reuse a container between users. The current supervisor and kernel share UID 10001, so a notebook can address `/work/output` or leave a background process racing supervisor output. A production broker must add kernel/output ownership separation or a two-stage extraction boundary, stop the container before accepting results, and revalidate every file after stop.

`kfive_notebook_runtime.verifier` is the source-tested second stage for that design. It executes no notebook code. After the broker has stopped and removed the user-code container, a fresh trusted verifier container must mount the immutable input and candidate output read-only and a distinct empty verified-output volume read-write. It rejects undeclared, symlinked, hardlinked, noncanonical, identity-mismatched, hash/size-mismatched, executable MIME, or malformed data and recreates the accepted bundle with exclusive writes. This module does not itself prove ordering: the still-missing broker must prove that the execution container is gone before starting it.

The Dockerfile exposes this as the explicit `verifier` build target with a fixed module entrypoint and UID `10002`; the default final target remains the UID `10001` execution runtime. A production broker must pin and identify both images independently. If verification exits nonzero or leaves a partial destination, the broker must discard all candidate/verified volumes and terminalize the canonical run with a fixed safe error.

## One-shot invocation

The entrypoint is:

```text
python -m kfive_notebook_runtime.supervisor \
  --input-dir /work/input \
  --output-dir /work/output \
  --workspace-dir /work/run
```

The default arguments are shown above. `/work/input` must contain exactly two non-symlink regular files: `manifest.json` and `notebook.ipynb`. `/work/output` and `/work/run` must be empty. Exit code `0` means the result status is `succeeded`, `1` means a normalized job failure was written, and `70` means even a safe `result.json` could not be written.

### Input manifest

Unknown or duplicate keys are rejected. The exact v1 shape is:

```json
{
  "schemaVersion": "kfive.notebook-job.v1",
  "runId": "run_01HXYZ",
  "notebookFile": "notebook.ipynb",
  "cellTimeoutSeconds": 10
}
```

`runId` is 1–64 ASCII letters, digits, `_` or `-`. The timeout is an integer from 1 through 30. Notebook JSON is limited to 1 MiB and must be canonical nbformat 4 JSON with 1–32 code/markdown cells. Cell ids are unique and safe; sources are strings limited to 64 KiB per cell and 256 KiB in total. Raw cells, attachments, prior outputs, prior execution counts, arbitrary metadata and non-Python kernels are rejected. Cells execute sequentially in one nbclient-managed Python kernel, preserving state.

### Output manifest

`result.json` is canonical UTF-8 JSON with sorted keys. Invalid input can produce a `null` run id; otherwise it exactly echoes the validated id:

```json
{
  "schemaVersion": "kfive.notebook-result.v1",
  "runId": "run_01HXYZ",
  "status": "succeeded",
  "startedAt": "2026-08-26T10:00:00.000Z",
  "finishedAt": "2026-08-26T10:00:01.250Z",
  "durationMs": 1250,
  "notebookFile": "executed.ipynb",
  "metrics": [{"name": "accuracy", "value": 0.91, "step": 4}],
  "artifacts": [{
    "path": "artifacts/report.json",
    "kind": "json",
    "mimeType": "application/json",
    "bytes": 42,
    "sha256": "64-lowercase-hex-characters"
  }],
  "error": null
}
```

For failures, `status` is `failed`, `notebookFile` is `null`, and `error` is `{code,message,cellIndex}` using a fixed redacted message. `cellIndex` is zero-based or `null`. The broker must validate the manifest again, verify every size/hash/path, ignore outputs for failed runs, and reject undeclared files.

`executed.ipynb` is normalized to bounded inert output: stdout/stderr and redacted traceback text, JSON, PNG and JPEG. HTML, JavaScript, SVG, arbitrary MIME bundles and metadata are removed. Images are decoded and re-encoded to strip metadata/trailing payloads and are capped at 4096×4096 and 1 MiB. Text output is capped at 512 KiB and total notebook output at 4 MiB.

Notebook code may export files beneath `artifacts/`. Only regular single-link `.txt`, `.json`, `.png`, `.jpg` and `.jpeg` files with portable relative paths are copied. JSON is structurally bounded and canonicalized; images are decoded/re-encoded. Limits are 20 files, 1 MiB each, and 4 MiB total. Symlinks, hardlinks, unsafe paths and unknown formats fail the run.

Metrics use:

```python
from kfive_runtime import log_metric
log_metric("validation.accuracy", 0.91, step=4)
```

Names and steps are bounded, values must be finite scalars, and at most 1,000 metrics/128 KiB are accepted. The supervisor revalidates the JSONL stream because notebook-created data is untrusted.

## Reproducibility and provenance

- Both build and runtime use official Docker Library `python:3.12.11-slim-bookworm`, pinned to multi-platform index digest `sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7`. For linux/amd64 Docker Hub reported manifest digest `sha256:c00fc7b44d844b6da22861ec24af43968a5200eac4ec607b4725d585165d6b49`. The index page was checked on 2026-08-26; the tag was already about eleven months old and Docker Hub reported known OS-package vulnerabilities. Pinning provides reproducibility, not a claim that the base is vulnerability-free. Rebase and rescan deliberately.
- `requirements.in` pins every intentionally exposed library and Docker accepts binary wheels only, then runs `pip check`. The transitive graph is not hash-locked yet, so a later registry change can alter a rebuild; generating and reviewing a complete Python 3.12 linux/amd64 hash lock remains required before this runtime can be promoted from experimental.
- The final Docker stage descends from the test stage, so a default image build runs the full unittest suite, including a real nbclient state-preservation test. Host tests use fakes for all boundary logic and skip only that actual-kernel test when Jupyter dependencies are absent.

Run host tests without Docker:

```bash
cd services/notebook-runtime
python3 -m unittest discover -s tests -v
```

At the time this slice was authored, the host lacked the Jupyter/scientific packages and Docker execution was not claimed. The stdlib suite therefore provides source-level evidence; a successful image build is still required before the broker marks the runtime healthy.
