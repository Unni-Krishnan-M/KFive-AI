const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBridge, listenSocket, upstreamAddress } = require('./server.cjs');

async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kfive-bridge-'));
  const socketPath = path.join(directory, 'bridge.sock');
  const bridge = createBridge({ upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, ...options });
  await listenSocket(bridge, socketPath);
  t.after(async () => {
    bridge.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => bridge.close(r)), new Promise(r => upstream.close(r))]);
    await fs.rm(directory, { recursive: true });
  });
  const request = (route = '/api/tags', method = 'GET', body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  return { request, bridge, upstream, socketPath, directory };
}

test('only literal loopback HTTP origins are accepted', () => {
  for (const value of ['http://example.com', 'http://localhost', 'http://127.0.0.1/api', 'http://user:pass@127.0.0.1', 'https://127.0.0.1', 'http://127.0.0.1?target=evil', 'http://127.0.0.1#x']) assert.throws(() => upstreamAddress(value));
  assert.equal(upstreamAddress('http://127.0.0.1:11434').port, '11434');
  assert.equal(upstreamAddress('http://[::1]:11434').hostname, '[::1]');
});

test('proxies JSON/streaming through a restricted Unix socket without credentials', async t => {
  let seen;
  const f = await fixture(t, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen = { headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Set-Cookie': 'secret=hidden' });
      res.write('{"token":"one"}\n'); res.end('{"done":true}\n');
    });
  });
  const result = await f.request('/api/chat', 'POST', '{"model":"test"}', { Authorization: 'secret', Cookie: 'private', Host: 'evil.example' });
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"token":"one"}\n{"done":true}\n');
  assert.equal(seen.body, '{"model":"test"}');
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers.cookie, undefined);
  assert.notEqual(seen.headers.host, 'evil.example');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal((await fs.stat(f.socketPath)).mode & 0o777, 0o660);
});

test('denies non-allowlisted routes, absolute URLs and methods before upstream access', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('{}'); });
  for (const route of ['/api/create', '/api/tags?url=evil', '//api/tags', 'http://127.0.0.1/api/tags', '/api/../api/tags']) assert.equal((await f.request(route)).status, 403);
  assert.equal((await f.request('/api/tags', 'POST', '{}')).status, 403);
  assert.equal((await f.request('/health')).status, 200);
  assert.equal(hits, 0);
});

test('rejects non-JSON and oversized bodies', async t => {
  const f = await fixture(t, (req, res) => { req.resume(); req.on('end', () => res.end('{}')); }, { maxRequestBytes: 16 });
  assert.equal((await f.request('/api/chat', 'POST', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/chat', 'POST', 'a'.repeat(32), { 'Content-Length': '32' })).status, 413);
  assert.equal((await f.request('/api/chat', 'POST', 'a'.repeat(32), { 'Transfer-Encoding': 'chunked' })).status, 413);
});

test('denies redirects and oversized upstream responses', async t => {
  let redirect = true;
  const f = await fixture(t, (_req, res) => {
    if (redirect) { res.writeHead(302, { Location: 'http://example.com' }); res.end(); }
    else { res.writeHead(200, { 'Content-Length': 100 }); res.end('x'.repeat(100)); }
  }, { maxResponseBytes: 16 });
  assert.equal((await f.request()).status, 502);
  redirect = false;
  assert.equal((await f.request()).status, 502);
});

test('terminates chunked responses over the byte limit and releases the slot', async t => {
  let oversized = true;
  const f = await fixture(t, (_req, res) => {
    if (oversized) {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.write('small');
      setImmediate(() => res.end('x'.repeat(32)));
    } else res.end('{}');
  }, { maxResponseBytes: 16, maxConcurrent: 1 });
  await assert.rejects(f.request());
  oversized = false;
  assert.equal((await f.request()).status, 200);
});

test('cancels upstream work when a streaming client disconnects', async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  let streaming = true;
  const f = await fixture(t, (_req, res) => {
    if (streaming) {
      res.once('close', closed);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"token":"start"}\n');
    } else res.end('{}');
  }, { maxConcurrent: 1, timeoutMs: 1000 });
  await new Promise((resolve, reject) => {
    const req = http.get({ socketPath: f.socketPath, path: '/api/tags' }, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.once('error', reject);
  });
  await upstreamClosed;
  streaming = false;
  assert.equal((await f.request()).status, 200);
});

test('returns an unavailable response after upstream shutdown without leaking a slot', async t => {
  const f = await fixture(t, (_req, res) => res.end('{}'), { maxConcurrent: 1 });
  await new Promise(resolve => f.upstream.close(resolve));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.request();
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error, 'BRIDGE_UPSTREAM_UNAVAILABLE');
  }
});

test('bounds upstream latency and releases concurrency after timeout', async t => {
  const f = await fixture(t, () => {}, { timeoutMs: 40, maxConcurrent: 1 });
  assert.equal((await f.request()).status, 504);
  assert.equal((await f.request()).status, 504);
});

test('limits concurrent requests without blocking local health', async t => {
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  let response;
  const f = await fixture(t, (_req, res) => { response = res; entered(); }, { maxConcurrent: 1 });
  const first = f.request();
  await pending;
  assert.equal((await f.request()).status, 429);
  assert.equal((await f.request('/health')).status, 200);
  response.end('{}');
  assert.equal((await first).status, 200);
});

test('does not unlink active sockets or ordinary files', async t => {
  const f = await fixture(t, (_req, res) => res.end('{}'));
  const other = createBridge({ upstreamUrl: 'http://127.0.0.1:11434' });
  await assert.rejects(listenSocket(other, f.socketPath), /already active/);
  const file = path.join(f.directory, 'keep.txt');
  await fs.writeFile(file, 'keep');
  await assert.rejects(listenSocket(other, file), /Refusing/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});
