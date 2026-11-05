#!/usr/bin/env node
'use strict';

const http = require('node:http');
const net = require('node:net');

const PORT = 9116;
const PROBE_TIMEOUT_MS = 2_000;
const CACHE_MS = 4_000;
const TARGETS = Object.freeze({
  mongodb: Object.freeze({ kind: 'tcp', host: 'mongodb.kfive.svc.cluster.local', port: 27017 }),
  redis: Object.freeze({ kind: 'tcp', host: 'redis.kfive.svc.cluster.local', port: 6379 }),
  chromadb: Object.freeze({ kind: 'http', host: 'chromadb.kfive.svc.cluster.local', port: 8000, path: '/api/v1/heartbeat' }),
});

function probeTcp(target, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    const socket = net.createConnection({ host: target.host, port: target.port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function probeHttp(target, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = http.request({
      host: target.host, port: target.port, path: target.path, method: 'GET',
      timeout: timeoutMs, agent: false, headers: { accept: 'application/json' },
    }, (response) => {
      const available = response.statusCode >= 200 && response.statusCode < 300;
      response.destroy();
      resolve(available);
    });
    request.once('timeout', () => request.destroy(new Error('probe timeout')));
    request.once('error', () => resolve(false));
    request.end();
  });
}

async function collectSubsystems(probes = {}) {
  const tcp = probes.probeTcp || probeTcp;
  const web = probes.probeHttp || probeHttp;
  const entries = await Promise.all(Object.entries(TARGETS).map(async ([name, target]) => {
    try {
      return [name, target.kind === 'tcp' ? await tcp(target) : await web(target)];
    } catch {
      return [name, false];
    }
  }));
  return Object.fromEntries(entries);
}

function renderMetrics(results) {
  const lines = [
    '# HELP kfive_subsystem_probe_success Whether the fixed independent subsystem probe succeeded.',
    '# TYPE kfive_subsystem_probe_success gauge',
  ];
  for (const name of ['mongodb', 'redis', 'chromadb']) {
    lines.push(`kfive_subsystem_probe_success{dependency="${name}",probe="${TARGETS[name].kind}"} ${results[name] === true ? 1 : 0}`);
  }
  lines.push('');
  return lines.join('\n');
}

function createCollector(options = {}) {
  const now = options.now || Date.now;
  const collect = options.collect || collectSubsystems;
  let cache;
  let inFlight;
  return async () => {
    const time = now();
    if (cache && cache.expiresAt > time) return cache.value;
    if (!inFlight) {
      inFlight = Promise.resolve().then(collect).then((value) => {
        cache = { value, expiresAt: now() + CACHE_MS };
        return value;
      }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  };
}

function createServer(options = {}) {
  const collect = createCollector(options);
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok\n');
      return;
    }
    if (request.method === 'GET' && request.url === '/metrics') {
      const results = await collect();
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(renderMetrics(results));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found\n');
  });
  server.maxConnections = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  return server;
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0');
}

module.exports = { collectSubsystems, createCollector, createServer, probeHttp, probeTcp, renderMetrics, TARGETS };
