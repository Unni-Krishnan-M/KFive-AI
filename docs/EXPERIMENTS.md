# Experiments

State: **Planned**.

KFive does not yet provide ML training runs, experiment comparison, best-run selection, parameter/resource charts, or persisted training artifacts. Dataset Lab, Model Benchmarks, and Notebook document editing are separate Experimental slices; none should be described as an ML experiment tracker.

Before ML Experiments can advance, KFive needs the trusted notebook/training broker and verifier boundary documented in [NOTEBOOKS.md](NOTEBOOKS.md), durable canonical run records, conservative GPU scheduling for approximately 8 GB VRAM, explicit CPU/RAM/GPU limits, cancellation and restart recovery, private bounded artifact storage, project/dataset ownership checks, immutable dataset references, and target-host end-to-end execution. The original dataset must never be overwritten.

Planned tracked fields are project, immutable dataset/version reference, model, parameters, metrics, duration, CPU/RAM/GPU/VRAM observations, bounded artifacts, notes, status, revisions, and an auditable timeline. Resource observations must be labeled as measurements or unavailable; KFive must not imply GPU use merely because a GPU exists on the host.
