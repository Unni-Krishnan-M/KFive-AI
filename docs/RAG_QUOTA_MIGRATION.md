# Knowledge source quota migration

Knowledge admission now permits at most 200 retained sources per owner across workspace, active/archived projects, deleted-project recovery, and every source status. Each new source stores a private immutable integer `quotaSlot` from 0 through 199. A partial unique MongoDB index on `(ownerId, quotaSlot)` arbitrates concurrent insertions. The source and slot are the same document: there is no separate reservation to leak after a process crash or release before source deletion.

The existing 64-KiB source limit bounds private input snapshots to 12.5 MiB for 200 sources, excluding BSON overhead, indexes, and vectors. This is not a complete vector-store retention bound: automatic abandoned-generation cleanup remains separate work.

## Upgrade

1. Drain older API writers and their in-flight ingestion before enabling new writers. Old releases do not assign quota slots; a mixed-version writer fleet cannot guarantee the quota. Reads may continue.
2. Inspect the target using the approved `MONGODB_URL` environment and `node scripts/migrations/20261121-rag-quota-index.cjs`. This defaults to read-only inspection and reports whether the exact enforcing index exists.
3. Apply `node scripts/migrations/20261121-rag-quota-index.cjs --apply`. This creates only `rag_owner_quota_slot_unique_v1`; it does not backfill, update, or delete any source. Repeating it is idempotent. Model initialization also declares this additive index, consistent with the repository's existing Mongo schema initialization. Admission awaits initialization and checks the enforcing index before inserting.
4. Run the new API writers. New sources count toward the limit immediately, including queued and failed records. A full owner receives HTTP 409 with `RAG_SOURCE_LIMIT_EXCEEDED`. Reading, querying, and permitted terminal-source deletion remain available.

A MongoDB index build scans existing records and can consume I/O and briefly lock metadata at its build boundaries; it is not a claim of zero downtime. The local acceptance migration uses a populated 196-source legacy fixture and verifies byte-for-byte logical record preservation. It does not establish large-production-database timing. Review the target's size and schedule the index build before releasing ingestion there.

Legacy records remain untouched. The bounded count of legacy records reserves that many low-numbered slots. Since drained legacy writers cannot add records, that count can only fall under supported operations; concurrent new inserts compete for unique remaining slots. Owners already above 200 retain their history, but cannot create another source until enough records are deleted. Legacy owners with more than 200 ready records still have the pre-existing 200-source retrieval bound; paginated history remains available.

## Failure and rollback behavior

Missing, nonunique, or differently filtered enforcement indexes fail admission closed. Only duplicate `(ownerId, quotaSlot)` collisions are retried; unrelated uniqueness failures and ambiguous database-write failures are not retried as new insertions. A concurrent stored-document ingestion that takes the last slot still returns the existing owner-scoped document source idempotently.

This migration is additive and has no required destructive rollback. Forward rollback keeps the index and slot fields, stops new admissions if necessary, and fixes the application in a new release. If rolling application code back to an older release, drain writers first and keep ingestion disabled until a quota-compatible release is restored; the older code does not enforce this quota. Do not drop the index while any quota-dependent writer is active. Direct database writes, restored records, or external importers must preserve the slot contract or be handled during a drained maintenance migration.

## Verification

`npm run verify:rag-quota` uses an isolated temporary MongoDB and independent production-repository processes. It covers eight-way contention for four remaining slots, an independent 200-slot owner, unchanged legacy data, over-limit legacy preservation, deletion/re-admission, process death after insertion, document uniqueness, missing-index rejection, private projection, Mongo restart, and exact cleanup. No existing application database is accessed.

See [quota evidence](../output/verification/rag-quota-live.json). Real production API/browser rejection is included in the [RAG recovery verifier](../scripts/verify-rag-recovery-live.cjs), which also verifies real Ollama/Chroma recovery.
