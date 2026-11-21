'use strict';

// Local fault injection only. This is not evidence for an external provider or GPU use.
const assert = require('node:assert/strict');
const http = require('node:http');

async function createFixture(model) {
  const fixture = { mode: 'boundary', calls: [], active: 0, peak: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: model, digest: 'local-contract-fixture-v1', capabilities: ['completion'] }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
    const call = { mode: fixture.mode, started: Date.now(), closed: false, parametersValid: false };
    fixture.calls.push(call); fixture.active += 1; fixture.peak = Math.max(fixture.peak, fixture.active);
    let timer;
    res.once('close', () => { clearInterval(timer); call.closed = true; call.closedAt = Date.now(); fixture.active -= 1; });
    try {
      let input = '';
      for await (const chunk of req) { input += chunk; assert.ok(Buffer.byteLength(input) < 16 * 1024); }
      const body = JSON.parse(input);
      assert.equal(body.model, model); assert.equal(body.stream, true);
      assert.deepEqual(body.options, { num_predict: 128, temperature: 0, top_p: 1 });
      call.parametersValid = true;
      res.setHeader('content-type', 'application/x-ndjson');
      const delta = (content) => res.write(`${JSON.stringify({ model, done: false, message: { role: 'assistant', content } })}\n`);
      if (call.mode === 'hold') {
        // Empty deltas keep the transport alive without approaching the output limit.
        delta(''); timer = setInterval(() => delta(''), 1000);
      } else if (call.mode === 'overflow') {
        delta('é'.repeat(8192)); delta('é');
        timer = setInterval(() => delta(''), 1000);
      } else {
        delta(call.mode === 'boundary' ? 'é'.repeat(8192) : 'fixture response');
        res.end(`${JSON.stringify({ model, done: true, done_reason: 'stop', eval_count: 1, prompt_eval_count: 1 })}\n`);
      }
    } catch (error) { call.error = error.message; res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.url = `http://127.0.0.1:${server.address().port}`;
  fixture.close = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  return fixture;
}

async function verify(h) {
  const { fixture, owner, stranger, request, stream, get, until, stop, startWorker, startApi, report, env, getWorker, getApi, success } = h;
  const start = (token = owner) => stream('/benchmarks/runs/stream', token, { start: true, first: true, allowRejectedStart: true });
  const follow = (run, token = owner) => stream(`/benchmarks/runs/${run.id}/stream`, token);
  const check = (message) => { report.checks.push(message); console.log(`PASS: ${message}`); };
  await startWorker(owner);
  const boundary = await stream('/benchmarks/runs/stream', owner, { start: true });
  success(boundary.run);
  assert.equal(boundary.run.outputBytes, 6 * 16 * 1024);
  for (const result of boundary.run.results) assert.equal(Buffer.byteLength(result.output), 16 * 1024);
  check('Six exact 16-KiB UTF-8 outputs persist; 96-KiB total stays below the defensive 128-KiB run bound');

  fixture.mode = 'overflow';
  const overflow = await stream('/benchmarks/runs/stream', owner, { start: true });
  assert.equal(overflow.run.status, 'output_limit'); assert.equal(overflow.run.error.code, 'BENCHMARK_OUTPUT_LIMIT');
  assert.equal(overflow.run.completedCalls, 0); assert.equal(overflow.run.outputBytes, 0); assert.deepEqual(overflow.run.results, []);
  await until(() => fixture.active === 0, 'oversized provider transport closed');
  assert.equal(fixture.calls.filter((call) => call.mode === 'overflow').length, 1);
  check('16-KiB plus one UTF-8 character stops after one call, persists no overflowing output, and closes provider transport');

  fixture.mode = 'hold';
  const timeoutStarted = Date.now();
  console.log('Checking the unmodified 180-second run timeout...');
  const timed = await stream('/benchmarks/runs/stream', owner, { start: true });
  assert.equal(timed.run.status, 'timed_out'); assert.equal(timed.run.error.code, 'BENCHMARK_TIMEOUT');
  assert.equal(timed.run.completedCalls, 0);
  const elapsed = Date.now() - timeoutStarted;
  assert.ok(elapsed >= 179_000 && elapsed < 205_000, `timeout elapsed ${elapsed}`);
  await until(() => fixture.active === 0, 'timed-out provider transport closed');
  report.timeoutElapsedMs = elapsed;
  check('Real 180-second timeout terminalizes once with zero completed calls and closes the held provider transport');

  const cancelling = await start();
  await until(() => fixture.active === 1, 'cancellation provider call');
  await request(`/benchmarks/runs/${cancelling.run.id}/cancel`, owner, 'POST');
  const cancelled = await follow(cancelling.run); assert.equal(cancelled.run.status, 'cancelled');
  await until(() => fixture.active === 0, 'cancelled provider transport closed');
  check('Running cancellation closes the provider fixture connection without another call');

  // Two real worker processes share a single Redis lease. The provider observes overlap independently.
  fixture.mode = 'success'; fixture.peak = 0;
  const firstWorker = getWorker(); await startWorker(owner);
  const starts = await Promise.all([start(owner), start(stranger)]);
  assert.ok(starts.every((item) => item.status === 200));
  const complete = await Promise.all([follow(starts[0].run, owner), follow(starts[1].run, stranger)]);
  complete.forEach((item) => success(item.run)); assert.equal(fixture.peak, 1);
  await stop(firstWorker); await stop(getWorker());
  check('Two owners and two worker processes complete twelve calls with provider-observed peak concurrency one');

  const { MongoClient, ObjectId } = require('mongoose').mongo;
  const mongo = new MongoClient(env.MONGODB_URL); await mongo.connect();
  try {
    const collection = mongo.db().collection('benchmarkruns');
    const source = await collection.findOne({ _id: new ObjectId(cancelled.run.id) });
    const existing = await collection.countDocuments({ ownerId: source.ownerId });
    // Seed terminal history in this disposable database only; boundary admissions still use the real API.
    const records = Array.from({ length: 99 - existing }, () => {
      const id = new ObjectId();
      const record = { ...source, _id: id, jobId: `benchmark-${id}` };
      delete record.activeOwnerSlot; delete record.execution;
      return record;
    });
    if (records.length) await collection.insertMany(records);
    assert.equal(await collection.countDocuments({ ownerId: source.ownerId }), 99);
    const hundredth = await start(); assert.equal(hundredth.status, 200);
    await request(`/benchmarks/runs/${hundredth.run.id}/cancel`, owner, 'POST');
    const denied = await start(); assert.equal(denied.status, 409);
    assert.match(JSON.stringify(denied.body), /BENCHMARK_LIMIT_REACHED/);
    assert.equal(await collection.countDocuments({ ownerId: source.ownerId }), 100);
    const ids = [];
    for (let page = 1; page <= 4; page += 1) {
      const data = (await request(`/benchmarks/runs?page=${page}`, owner)).data;
      assert.equal(data.pagination.total, 100); assert.equal(data.runs.length, 25);
      ids.push(...data.runs.map((run) => run.id));
    }
    assert.equal(new Set(ids).size, 100);
    assert.equal((await request('/benchmarks/runs?page=5', owner)).data.runs.length, 0);
    assert.equal((await request('/benchmarks/runs', stranger)).data.pagination.total, 1);
    await request(`/benchmarks/runs/${hundredth.run.id}`, owner, 'DELETE');
    const replacement = await start(); assert.equal(replacement.status, 200);
    await request(`/benchmarks/runs/${replacement.run.id}/cancel`, owner, 'POST');
    check(`With ${records.length} seeded terminal records: admit record 100, reject 101 without persistence, paginate 100 unique IDs, delete and readmit`);

    // Leave two retention slots so the active-owner index, rather than retention, decides the race.
    await request(`/benchmarks/runs/${replacement.run.id}`, owner, 'DELETE');
    await request(`/benchmarks/runs/${boundary.run.id}`, owner, 'DELETE');
    // Restart only the disposable API to test persisted index enforcement independently of in-process state.
    await stop(getApi()); await startApi();
    const raced = await Promise.all([start(), start()]);
    assert.deepEqual(raced.map((item) => item.status).sort(), [200, 429]);
    const rejected = raced.find((item) => item.status === 429); assert.match(JSON.stringify(rejected.body), /BENCHMARK_BUSY/);
    const accepted = raced.find((item) => item.status === 200);
    assert.equal(await collection.countDocuments({ ownerId: source.ownerId, activeOwnerSlot: true }), 1);
    await request(`/benchmarks/runs/${accepted.run.id}/cancel`, owner, 'POST');
    assert.equal((await get(accepted.run.id, owner)).completedCalls, 0);
    check('Concurrent owner starts admit exactly one durable queued run and return BENCHMARK_BUSY for the loser');
    assert.ok(fixture.calls.every((call) => call.parametersValid && !call.error));
    report.providerCalls = fixture.calls.length;
    report.fixtureOnly = true;
  } finally { await mongo.close(); }
}

module.exports = { createFixture, verify };
