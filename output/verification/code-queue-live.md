# Code queue verification — 2026-09-19

Commands executed:

- `npm test --workspace @kfive/code-runner`: eight test files passed.
- `node scripts/verify-code-runner-live.cjs --allow-live-test`: eleven scenarios passed again.
- `node scripts/verify-code-queue-live.cjs --allow-live-test`: real Redis dispatch,
  worker/Docker execution, retained queue result across graceful worker restart,
  and Redis cancellation passed. The worker removed the cancelled runtime and
  cancellation marker. Verifier removed its dedicated Redis container.

The fixture uses an ephemeral loopback port, a dedicated Redis container with no
application volume, and actual production runner classes. No application DB or
existing queue is accessed. Redis image ID:
`sha256:ccd6aa8d45ff3f033d6fa15b8cc1a50579f65c89f38cf9bb607a954c4f2128ed`.

Docker skill guided fixture isolation. Read-only subagent review identified the
terminal cancellation/Mongo reconciliation race and split Redis configuration
gap. Neither finding was fixed in this verification slice. Authenticated API,
Mongo history, browser execution, and broker crash recovery remain pending.
