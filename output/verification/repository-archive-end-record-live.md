# Repository Analyzer bounded ZIP end-record verification

Date: 2026-11-05  
State: Experimental hardening slice

## Defect and RED

The prior encryption pre-scan searched every byte in the classic EOCD window and, for every structurally plausible signature, traversed the attacker-declared central-entry count. The application 2,000-entry cap and analysis timer ran only afterward; the timer could not preempt synchronous JavaScript work. A separate comment sanitizer repeated the tail scan and could select a different superficially plausible record.

The first RED used a 3,080,085-byte malformed buffer with 65,534 central-header-shaped records and 2,978 plausible EOCD candidates. The hostile case consumed about 24,016 ms and caused the focused suite to finish in 25.15 seconds after exceeding the test's 10-second timeout. This result is retained as defect evidence, not as a permanent timing-dependent unit test.

## Repair contract

One shared inspector now:

- searches only the final 65,557 bytes using native reverse signature search;
- admits at most eight structurally plausible candidates;
- permits at most 2,001 cumulative central-header visits;
- checks single-disk counts, offsets, sizes, minimum header size, and exact central-directory termination;
- rejects ZIP64 sentinels, multi-disk records, budget exhaustion, and multiple coherent interpretations;
- derives encryption from the single selected directory and sanitizes only that record's comment.

The permanent regression uses a smaller hostile fixture and a deterministic `readUInt32LE` operation ceiling of 5,000, so correctness does not depend on host timing. Focused coverage passes 1 suite / 21 tests, including encrypted entries, 2,001 entries, an empty classic ZIP, an ordinary fake signature, the 65,535-byte maximum comment, ambiguous coherent records, ZIP64 count/size/offset sentinels, and nonzero/mismatched disk metadata.

## Built-code target-process measurement

After `npm run build:backend`, `node scripts/verify-repository-archive-end-live.cjs` exercised the original full-size shape against `backend/dist`:

```json
{
  "inputBytes": 3080085,
  "centralEntries": 65534,
  "candidates": 2978,
  "resultCode": "INVALID_REPOSITORY_ARCHIVE",
  "analysisElapsedMs": 0.356,
  "timerLagMs": 0.381,
  "ceilingMs": 250
}
```

The verifier is read-only and creates no files, accounts, containers, database records, or network traffic.

## Merge gates and review

- Backend: 81 suites / 555 tests passed.
- Frontend remained unchanged from the immediately preceding gate: 23 files / 162 tests passed.
- Frontend, backend, and code-runner production builds passed; only the existing Browserslist-age and large-chunk warnings remain.
- Backend lint passed with zero warnings.
- Six production Compose/auth/backup/performance/hybrid/TLS contract files passed.
- Compose rendering, the production high-severity audit gate, verifier syntax, and `git diff --check` passed. The audit reports 0 critical/high and six separately documented moderate findings requiring breaking upgrades.
- Independent implementation and defensive security reviews returned GO. Their non-blocking documentation requirements are incorporated here and in `docs/REPOSITORY_ANALYZER.md`.

## Boundary

This proves that the identified classic-ZIP EOCD candidate/header amplification is structurally bounded and fast on the current target process. It is not comprehensive hostile-resource certification. Parsing still shares the backend event loop and memory, process-local admission/rate state does not coordinate replicas, and no dedicated importer/container resource boundary has passed. Repository Analyzer therefore remains Experimental.
