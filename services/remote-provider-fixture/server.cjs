#!/usr/bin/env node
'use strict';

const http = require('node:http');

const PORT = 4010;
const MODEL = 'remote-chat';
const RESPONSE = 'REMOTE_PROVIDER_VERIFIED';
const expectedAuthorization = `Bearer ${process.env.FIXTURE_BEARER_TOKEN || ''}`;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function authorized(request, response) {
  if (!process.env.FIXTURE_BEARER_TOKEN || request.headers.authorization !== expectedAuthorization) {
    json(response, 401, { error: { message: 'unauthorized' } });
    return false;
  }
  return true;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > 64 * 1024) {
        reject(new Error('request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid json')); }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok' });
  if (request.method === 'GET' && request.url === '/v1/models') {
    if (!authorized(request, response)) return;
    return json(response, 200, { data: [{ id: MODEL, created: 1, owned_by: 'kfive-fixture' }] });
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    if (!authorized(request, response)) return;
    try {
      const body = await readJson(request);
      if (body.model !== MODEL || !Array.isArray(body.messages) || body.messages.length === 0) {
        return json(response, 400, { error: { message: 'invalid request' } });
      }
      if (body.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'close',
        });
        response.write(`data: ${JSON.stringify({ model: MODEL, choices: [{ delta: { content: RESPONSE }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ model: MODEL, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      return json(response, 200, {
        model: MODEL,
        choices: [{ message: { content: RESPONSE }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    } catch {
      return json(response, 400, { error: { message: 'invalid request' } });
    }
  }
  return json(response, 404, { error: { message: 'not found' } });
});

server.maxConnections = 16;
server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.listen(PORT, '0.0.0.0');
