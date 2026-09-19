const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');

const routes = new Set(['GET /api/tags', 'GET /api/version', 'GET /api/ps', 'POST /api/show', 'POST /api/chat', 'POST /api/embed', 'POST /api/embeddings', 'POST /api/pull', 'DELETE /api/delete']);
function upstreamAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Upstream must be an HTTP literal loopback origin without credentials or path.');
  }
  return url;
}

function createBridge({ upstreamUrl, timeoutMs = 600000, maxRequestBytes = 4 * 1024 * 1024, maxResponseBytes = 16 * 1024 * 1024, maxConcurrent = 4 }) {
  const target = upstreamAddress(upstreamUrl);
  let active = 0;
  const server = http.createServer((req, res) => {
    const reject = (status, code) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: code }));
    };
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (!routes.has(`${req.method} ${req.url}`)) return reject(403, 'BRIDGE_ROUTE_DENIED');
    if (active >= maxConcurrent) return reject(429, 'BRIDGE_BUSY');
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > maxRequestBytes)) return reject(413, 'BRIDGE_REQUEST_LIMIT');
    if (req.method !== 'GET' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reject(415, 'BRIDGE_JSON_REQUIRED');
    active += 1;
    let released = false;
    let failed = false;
    let response;
    let upstream;
    const finish = () => {
      if (released) return;
      released = true;
      active -= 1;
      clearTimeout(timer);
      upstream?.destroy();
      response?.destroy();
    };
    const fail = (status, code) => {
      if (failed || released) return;
      failed = true;
      req.unpipe(upstream);
      upstream?.destroy();
      response?.destroy();
      if (res.headersSent) res.destroy();
      else reject(status, code);
    };
    const timer = setTimeout(() => fail(504, 'BRIDGE_UPSTREAM_TIMEOUT'), timeoutMs);
    timer.unref();
    res.once('finish', finish);
    res.once('close', finish);
    req.once('aborted', () => fail(400, 'BRIDGE_CLIENT_ABORTED'));
    req.once('error', () => fail(400, 'BRIDGE_CLIENT_ERROR'));
    // Fixed origin and exact allowlisted path: never forward client Host,
    // credentials, proxy headers, redirects, or arbitrary absolute request URLs.
    upstream = http.request(new URL(req.url, target), {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', ...(length ? { 'Content-Length': length } : {}) },
    }, incoming => {
      response = incoming;
      if (failed || released) return incoming.destroy();
      if (incoming.statusCode >= 300 && incoming.statusCode < 400) return fail(502, 'BRIDGE_REDIRECT_DENIED');
      const responseLength = Number(incoming.headers['content-length']);
      if (responseLength > maxResponseBytes) return fail(502, 'BRIDGE_RESPONSE_LIMIT');
      let received = 0;
      res.writeHead(incoming.statusCode || 502, { 'Content-Type': incoming.headers['content-type'] || 'application/json' });
      incoming.on('data', chunk => {
        received += chunk.length;
        if (received > maxResponseBytes) return fail(502, 'BRIDGE_RESPONSE_LIMIT');
        if (!res.write(chunk)) incoming.pause();
      });
      res.on('drain', () => incoming.resume());
      incoming.once('end', () => res.end());
      incoming.once('error', () => fail(502, 'BRIDGE_UPSTREAM_ERROR'));
      incoming.once('aborted', () => fail(502, 'BRIDGE_UPSTREAM_ABORTED'));
    });
    upstream.once('error', () => fail(502, 'BRIDGE_UPSTREAM_UNAVAILABLE'));
    let sent = 0;
    req.on('data', chunk => {
      sent += chunk.length;
      if (sent > maxRequestBytes) fail(413, 'BRIDGE_REQUEST_LIMIT');
    });
    req.pipe(upstream);
  });
  server.requestTimeout = Math.min(timeoutMs, 600000);
  server.headersTimeout = Math.min(30000, server.requestTimeout);
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}

async function listenSocket(server, socketPath) {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100 || path.normalize(socketPath) !== socketPath) throw new Error('Invalid socket path.');
  const existing = await fs.lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid()) throw new Error('Refusing to replace a non-owned socket entry.');
    const stale = await new Promise(resolve => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    if (!stale) throw new Error('Bridge socket is already active or cannot be checked.');
    const current = await fs.lstat(socketPath);
    if (current.ino !== existing.ino || !current.isSocket()) throw new Error('Socket entry changed during startup.');
    await fs.unlink(socketPath);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o660);
}

if (require.main === module) {
  process.umask(0o007);
  const bridge = createBridge({ upstreamUrl: process.env.KFIVE_OLLAMA_HOST_URL || 'http://127.0.0.1:11434' });
  listenSocket(bridge, '/run/ollama-bridge/ollama.sock').then(() => {
    console.log(JSON.stringify({ service: 'ollama-host-bridge', transport: 'unix-socket', listening: true, gpuVerified: false }));
  }).catch(() => { console.error('Ollama bridge failed to start; no TCP listener was opened.'); process.exitCode = 1; bridge.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    bridge.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
module.exports = { createBridge, listenSocket, upstreamAddress };
