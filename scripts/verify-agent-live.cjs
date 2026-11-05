const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const base = 'http://127.0.0.1:3002/api/v1';

async function request(token, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  return { response, body };
}

async function register(prefix) {
  const suffix = randomBytes(5).toString('hex');
  const username = `${prefix}_${suffix}`;
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      email: `${username}@example.test`,
      password: randomBytes(24).toString('hex'),
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.accessToken;
}

async function terminalizeForCleanup(token, agentId, runId) {
  let detail = await request(token, `/agents/${agentId}/runs/${runId}`);
  if (['queued', 'running', 'cancel-requested'].includes(detail.body?.data?.run?.status)) {
    await request(token, `/agents/${agentId}/runs/${runId}/cancel`, { method: 'POST' });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      detail = await request(token, `/agents/${agentId}/runs/${runId}`);
      if (!['queued', 'running', 'cancel-requested'].includes(detail.body?.data?.run?.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Agent run ${runId} did not terminalize during cleanup.`);
  }
}

async function streamRun(token, agentId, prompt, onRun) {
  const response = await fetch(`${base}/agents/${agentId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt }),
  });
  if (response.status !== 200) {
    const failure = await response.text();
    assert.equal(response.status, 200, failure);
  }
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.ok(response.body);
  const decoder = new TextDecoder();
  let buffer = '';
  let runId;
  let completed;
  let streamError;
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      const payload = JSON.parse(data);
      if (event === 'run') {
        runId = payload.run.id;
        if (onRun) await onRun(runId);
      } else if (event === 'completed') completed = payload.run;
      else if (event === 'error') streamError = payload;
    }
    if (done) break;
  }
  assert.ok(runId, 'The stream did not publish a durable run id.');
  return { runId, completed, streamError };
}

async function main() {
  assert.ok(process.argv.includes('--allow-live-test'), 'Pass --allow-live-test to create dedicated Agent fixtures.');
  const ownerToken = await register('ag_owner');
  const otherToken = await register('ag_other');
  let agentId;
  const runIds = [];
  const rememberRun = (runId) => { if (!runIds.includes(runId)) runIds.push(runId); };
  try {
    const created = await request(ownerToken, '/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Agent Live Verification',
        description: 'Disposable real-provider verification agent.',
        systemPrompt: 'Follow the user instruction exactly. Never call tools. Return only the requested verification token.',
        aiModel: 'phi3:latest',
        temperature: 0,
        tools: [],
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    agentId = created.body.data.id;

    const success = await streamRun(
      ownerToken,
      agentId,
      'Reply with exactly AGENT_SUCCESS_92126 and nothing else.',
      async (runId) => rememberRun(runId)
    );
    assert.equal(success.completed?.status, 'succeeded', JSON.stringify(success));
    assert.match(success.completed.output, /AGENT_SUCCESS_92126/);

    let cancelResponse;
    const cancelled = await streamRun(
      ownerToken,
      agentId,
      'Write a very long numbered explanation with at least 500 sections. Begin with AGENT_CANCEL_STARTED_92126.',
      async (runId) => {
        rememberRun(runId);
        cancelResponse = await request(ownerToken, `/agents/${agentId}/runs/${runId}/cancel`, { method: 'POST' });
      }
    );
    assert.equal(cancelResponse.response.status, 200, JSON.stringify(cancelResponse.body));

    const cancelledDetail = await request(ownerToken, `/agents/${agentId}/runs/${cancelled.runId}`);
    assert.equal(cancelledDetail.response.status, 200, JSON.stringify(cancelledDetail.body));
    assert.equal(cancelledDetail.body.data.run.status, 'cancelled');
    assert.ok(cancelledDetail.body.data.run.timeline.some((event) => event.type === 'cancel_requested'));
    assert.ok(cancelledDetail.body.data.run.timeline.some((event) => event.type === 'cancelled'));

    const list = await request(ownerToken, `/agents/${agentId}/runs?page=1`);
    assert.equal(list.response.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.pagination.total, 2);
    assert.deepEqual(new Set(list.body.data.runs.map((run) => run.id)), new Set(runIds));

    const deniedAgent = await request(otherToken, `/agents/${agentId}`);
    assert.equal(deniedAgent.response.status, 404);
    const deniedRun = await request(otherToken, `/agents/${agentId}/runs/${success.runId}`);
    assert.equal(deniedRun.response.status, 404);

    console.log(JSON.stringify({
      passed: true,
      agentId,
      successRunId: success.runId,
      cancelledRunId: cancelled.runId,
      successMarker: 'AGENT_SUCCESS_92126',
    }));
  } finally {
    if (agentId) {
      for (const runId of runIds) {
        await terminalizeForCleanup(ownerToken, agentId, runId);
        const removed = await request(ownerToken, `/agents/${agentId}/runs/${runId}`, { method: 'DELETE' });
        assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
      }
      const removedAgent = await request(ownerToken, `/agents/${agentId}`, { method: 'DELETE' });
      assert.equal(removedAgent.response.status, 200, JSON.stringify(removedAgent.body));
    }
  }
  console.log('PASS: browser proxy -> authenticated Agent API -> provider SSE -> Mongo history/cancellation -> owner isolation -> cleanup.');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
