# Production TLS edge

## State and boundary

The production TLS edge is **Experimental**. KFive supplies a validated renderer for an operator-managed Nginx edge, and a disposable same-host live cell passed strict private-CA and hostname verification, HTTP-to-HTTPS routing, API/provider streaming, restart persistence, and forwarding-spoof resistance. The production Compose frontend remains bound to loopback HTTP; the TLS proxy is a separate process and is the only component that should receive public traffic. Loopback is not isolation from other processes or administrators on a hostile multi-user host, so the current boundary assumes a trusted, access-controlled host.

This proof used a short-lived private CA and a nonce `*.acceptance.invalid` hostname on one Docker host. It does not prove public DNS, a publicly trusted certificate, ACME issuance or renewal, Internet/WAN behavior, a clean remote host, a real external provider, browser trust-store behavior, or operation after the development laptop is offline.

## Render the edge configuration

Prepare the fully validated production environment first. `PUBLIC_BASE_URL` must be the exact HTTPS origin clients will use, including a non-default port when applicable. `KFIVE_EDGE_HTTP_PORT` must remain loopback-only and `TRUST_PROXY_HOPS` must be `2` for TLS edge → frontend → backend.

The certificate and private key must be regular, non-symlink files. The key must exclude group and other permissions, the leaf certificate must match the exact DNS-shaped hostname and private key, be valid now, and remain valid for at least seven days. Syntax validation does not prove public DNS ownership or resolution. Create a new config file; the renderer refuses to overwrite an existing path.

```bash
chmod 600 /secure/kfive.production.env /secure/tls/kfive.key
npm run production:tls:render -- \
  --env-file /secure/kfive.production.env \
  --certificate /secure/tls/kfive.crt \
  --private-key /secure/tls/kfive.key \
  --output /secure/tls/kfive-nginx.conf
```

The renderer validates the complete production environment, derives the DNS name, public HTTPS port, and redirect origin only from `PUBLIC_BASE_URL`, validates the certificate with OpenSSL, and creates the output mode `0600`. It emits the verified rootless-container contract: internal HTTP `8080`, internal HTTPS `8443`, and upstream `frontend:8080` on the production edge network. Publish host port 80 to 8080 and the exact public HTTPS port (443 when omitted from `PUBLIC_BASE_URL`) to 8443. The CLI prints that exact mapping.

Run a reviewed immutable KFive frontend image as the TLS process because it contains the accepted unprivileged Nginx runtime. Mount the generated files at the exact rendered paths and attach only the production edge network. The runtime identity must be the image's reviewed non-root UID/GID and must own or be able to read the mode-0600 private key; do not broaden key permissions. In schematic form (replace every angle-bracket value after inspecting the exact image and project):

```bash
docker run -d --name kfive-tls-edge \
  --user <reviewed-uid>:<reviewed-gid> \
  --network <production-project>_edge \
  --publish 0.0.0.0:80:8080 \
  --publish 0.0.0.0:<public-https-port>:8443 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 32 --memory 64m --cpus 0.25 \
  --no-healthcheck \
  --mount type=bind,src=/secure/tls/kfive-nginx.conf,dst=/run/kfive-tls/nginx.conf,readonly \
  --mount type=bind,src=/secure/tls/kfive.crt,dst=/run/kfive-tls/certificate.crt,readonly \
  --mount type=bind,src=/secure/tls/kfive.key,dst=/run/kfive-tls/private.key,readonly \
  --entrypoint nginx <immutable-kfive-frontend-image> \
  -c /run/kfive-tls/nginx.conf -g 'daemon off;'
```

The inherited frontend HTTP healthcheck is explicitly disabled because it targets the unknown-Host-rejecting public listener. Supervise this edge with an external strict-CA, exact-hostname HTTPS readiness probe and alert on both process exit and probe failure. The local acceptance host also cannot execute any Docker health command because of a daemon/AppArmor defect, so it verified this explicit no-healthcheck state plus the external readiness loop; target-host service supervision remains a deployment acceptance requirement.

## Required runtime boundary

- Publish the TLS edge publicly. Keep the inner frontend's host binding on `127.0.0.1:${KFIVE_EDGE_HTTP_PORT}`; the TLS container reaches it only as `frontend:8080` on the edge network.
- Mount only the rendered config, certificate, and private key read-only. Do not bake keys into images or copy them into the repository.
- Run the proxy as a non-root user with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, bounded CPU/memory/PIDs, and writable temporary directories only.
- Attach the proxy only to the edge network. Never attach it to MongoDB, Redis, ChromaDB, provider, Docker socket, or other private networks.
- Keep `TRUST_PROXY_HOPS=2`. The outer edge replaces `X-Forwarded-For` and `X-Real-IP` with its peer address, sets `X-Forwarded-Proto: https`, and clears `Forwarded`, `X-Forwarded-Host`, and `X-Forwarded-Port`. The inner frontend appends its hop.
- Use the fixed configured origin for HTTP redirects. Unknown HTTP hosts receive 421 and an unknown TLS SNI is rejected.
- TLS is limited to 1.2/1.3 with session tickets disabled. HSTS is `max-age=31536000` without `includeSubDomains` or `preload`; add either only after separately accepting every affected hostname and the operational rollback cost.
- Access logging is off in the supplied template to avoid accidental query-string leakage. Add a reviewed structured, redacted logging policy before production use.

The configuration disables response and request buffering for streaming, retains HTTP/1.1 Upgrade handling, accepts bodies up to 52 MiB, and uses 95-second proxy timeouts. Review these limits against the deployment workload without weakening the forwarding or origin controls.

## Verification and certificate operations

Run the destructive disposable verifier only on a development Docker daemon:

```bash
npm run production:verify:tls
```

It creates uniquely labelled images, containers, networks, volumes, certificates, and application records; verifies absence before use; and removes only resources whose ownership is proven. It must never target a real deployment. The latest result is recorded in [production-tls-live.md](../output/verification/production-tls-live.md).

For a real domain, the operator still owns DNS, certificate issuance, renewal, private-key rotation, revocation, expiry alerting, TLS service supervision, firewall policy, and rollback. Re-render to a new path, validate the proxy configuration, replace the service configuration atomically, reload or restart the edge, and verify strict hostname/chain validation plus SSE/WebSocket behavior from outside the host. Do not disable certificate verification during diagnosis.
