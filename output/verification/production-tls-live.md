# Production TLS edge live verification

Date: 2026-10-25  
State: **Experimental**  
Final nonce: `0e4f5acb3002`

## Scope

This disposable cell verified the KFive production TLS renderer and operator-managed Nginx edge on the local Docker host. It used a short-lived private CA, a leaf certificate for `tls-0e4f5acb3002.acceptance.invalid`, current source images, the production Compose topology, and an independently managed authenticated provider fixture.

The cell did not use a public DNS record, public certificate authority, ACME, remote host, WAN path, real provider credential, browser trust store, immutable registry artifact, or laptop-off test. It is a bounded same-host TLS/proxy protocol proof.

## TDD and implementation

The focused contract initially failed because the renderer, template, package commands, and verifier did not exist. The implemented regression covers:

- an exact HTTPS public origin and DNS-shaped hostname;
- matching certificate SAN/private key and at least seven days remaining validity;
- a normalized regular non-symlink certificate/key, restrictive private-key permissions, safe upstream, and create-new mode-0600 output;
- fixed-origin HTTP 308, unknown-host 421, unknown-SNI rejection, TLS 1.2/1.3, tickets off, HSTS, header replacement, streaming, and Upgrade behavior;
- strict verifier CA/hostname validation, two-hop proxy trust, spoof-resistant authentication rate limiting, ownership-gated cleanup, and absence of volume-pruning commands.

Live iterations found and fixed verifier/edge defects before the passing run: custom DNS lookup handling for Node's `all` mode, duplicate upstream HSTS, duplicate `X-Content-Type-Options`, the accepted strict wrong-SNI rejection error classification, and an inherited frontend healthcheck incompatible with unknown-Host rejection. Attempts to replace that check also exposed the host's known daemon/AppArmor defect: every Docker exec-health command fails before execution with `operation not permitted`. The final contract therefore explicitly disables the inherited check and requires the strict external HTTPS readiness probe. Failed iterations entered the exact cleanup path before the next nonce.

## Passing live result

The final run passed:

- strict CA and exact-hostname verification with TLS 1.3; the untrusted CA and wrong hostname/SNI paths failed closed;
- certificate SHA-256 fingerprint `6F:9C:35:AC:2B:82:95:E8:42:F8:3A:BB:76:29:7B:8D:0B:DB:3B:BD:50:77:46:B4:30:A7:D3:61:1B:BA:59:08`;
- fixed `https://tls-0e4f5acb3002.acceptance.invalid:36103` redirect preserving path/query, while hostile HTTP Host and HTTPS Host requests received 421;
- exactly one `Strict-Transport-Security: max-age=31536000` and one `X-Content-Type-Options: nosniff` response header;
- exact-origin CORS preflight success and attacker-origin rejection;
- HTTPS registration, authenticated remote-provider model discovery, and structurally validated SSE ending in the exact `REMOTE_PROVIDER_VERIFIED` marker;
- six failed logins with different attacker-supplied forwarding headers producing `[401, 401, 401, 401, 401, 429]` and `AUTH_RATE_LIMIT_EXCEEDED`, proving one real-client limiter bucket;
- restart of the same backend and TLS proxy containers, retention of the same certificate fingerprint, successful login, Mongo-backed chat history, and post-restart readiness;
- unchanged identities for the five disposable MongoDB, Redis, ChromaDB, upload, and log volume objects across restart;
- a non-root, read-only, capability-free, `no-new-privileges` TLS container bounded to 64 MiB, 0.25 CPU, and 32 PIDs, attached only to the edge network with three read-only mounts;
- explicit disabling of the incompatible inherited image healthcheck plus a passing strict external CA/hostname HTTPS readiness loop; Docker exec-health remains unavailable on this host because of the recorded AppArmor defect;
- loopback-only HTTP/TLS edge and inner frontend bindings, with no published backend, worker, datastore, or provider ports;
- exact deletion of one verifier user and one conversation, removal of all nonce resources/images and private certificate material, and preservation of every pre-existing Docker volume identity.

## Merge gate and limitations

The final merge gate passed:

- `npm run test:production`: six production contract files passed, including TLS and Hybrid regressions;
- frontend and backend production builds passed; the frontend retained its existing chunk-size advisory only;
- renderer/verifier syntax checks and `git diff --check` passed;
- independent implementation review returned GO after the listener/runtime, backend identity, certificate-current-validity, and health-supervision gaps were fixed;
- independent security review returned GO with no high- or medium-severity findings; its low-priority validity/path/boundary wording findings were addressed;
- the existing development stack remained ready at `127.0.0.1:3002`, with MongoDB and Redis available;
- post-run Docker container, image, volume, and network searches found no resource containing nonce `0e4f5acb3002`.

This result does not certify public TLS, certificate lifecycle automation, public-browser rendering, Internet security controls, a remote server, hostile multi-tenancy, real provider governance, off-host recovery, multi-replica operation, or independence from the development laptop. The feature remains **Experimental**.
