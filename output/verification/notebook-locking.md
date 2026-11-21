# Notebook dependency and image locking

Date: 2026-11-20  
State: **Implemented source/build slice; AppArmor-host execution acceptance remains incomplete**

## Changes and evidence

- Captured the 52 installed package/version pairs from the existing Python 3.12.11/Linux x86_64 runtime in a disposable network-disabled container. Downloaded only those exact wheels, hashed their bytes, and checked every direct requirement against the complete graph. No package versions changed.
- Both runtime and independent verifier build from `requirements.lock` with explicit SHA-256 checking, binary-only installation, and `pip check`. The existing immutable Python base reference is unchanged. All **68 in-image tests** passed, including the actual kernel and runtime/export/verifier pipeline. A fresh metadata read proved all 52 installed versions match the previous runtime exactly.
- An offline download using a deliberately altered first-wheel hash failed with pip's hash-mismatch error. Deterministic regeneration reproduced the lock exactly. The first attempted host `pip install --dry-run` was stopped by the system's externally-managed-environment policy; the effective tamper test used `pip download` and installed nothing on the host.
- Enabled configuration and the executor now reject mutable runtime/verifier references. Registry-digest inputs are inspected once per execution, and both `docker create --pull never` calls use the resulting exact image IDs. Tests cover mutable-reference rejection and actual create arguments. The local startup helper resolves development build names to IDs and exports those IDs to Compose; direct Compose has no mutable fallback.
- Docker now reports `name=apparmor,profile=default` on this host. A failing test reproduced the old exact-string capability check; parsing now recognizes the exact capability name before optional metadata and rejects lookalikes. Required AppArmor, seccomp, no-new-privileges, non-root execution, and all resource/mount gates remain enforced.

## Gates

| Gate | Result |
| --- | --- |
| Full backend regression outside the socket-restricted sandbox | 83 suites / 583 tests PASS |
| Focused config/executor checks | 40 tests PASS |
| Runtime/verifier Docker builds | PASS; 68 image tests PASS |
| Backend build and lint | PASS |
| Notebook lock, tooling-security, importer Compose contracts | PASS |
| Local Compose rendering and shell syntax | PASS |
| Wheel-hash tamper rejection and lock regeneration | PASS |
| Installed graph comparison | All 52 versions unchanged |
| Required AppArmor execution canary | FAIL at runtime input preload; exact container cleanup PASS |

The initial full backend run inside the sandbox could not create the Unix sockets used by existing tests; the unrestricted rerun above is the authoritative regression result. The original images were preserved under their existing tags. The new local image identities are:

```text
runtime:  sha256:cf10c7005eb87d773e3214cb85c45a67caaf0b9e43df049728d72b94fff70600
verifier: sha256:c910ca1c8cb26c5ad4671ccf77f904e5cc69a14de5fa66fe09afe0de16b9c339
```

These are Docker-reported local content IDs, not a claim that registry artifacts have been published.

## Confirmed host failure

`node scripts/verify-notebook-lock-live.cjs --allow-live-test` resolves those IDs, requires AppArmor, submits only a fixed harmless print statement, and compares the labeled runtime/verifier container set before and after execution. It reports `Docker runtime input preload failed` and `EXACT_CONTAINER_CLEANUP_OK`.

Recent Docker daemon logs identify the failed operation as an OCI exec profile transition: `apparmor failed to apply profile` while writing the process's `attr/apparmor/exec`, returning `operation not permitted`. AppArmor is enabled in the kernel and its service is active. Installed versions observed: Docker 29.10.0, containerd 2.4.2, runc 1.5.3, AppArmor 4.1.8, CachyOS kernel 7.3.5. These observations establish the failing host operation, not its root cause. No host profile, daemon setting, kernel policy, or privilege restriction was weakened to make the test pass.

The worker must remain unavailable until its real required isolation canary succeeds on a functioning host. This record does not establish new browser/API/Redis/Mongo notebook E2E, horizontal fencing, remote/Kubernetes notebook execution, registry signing, dependency vulnerability clearance, or general hostile-code certification. The wider Notebook feature remains **Experimental**.
