const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, installShutdownHandlers } = require('./server.cjs');
const { ProcessingError } = require('./processor.cjs');

test('HTTP contract enforces PDF MIME and returns extraction JSON', async () => {
  const server = createServer(async bytes => ({ text: bytes.toString(), pageCount: 1 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', capabilities: { pdfText: true, ocr: true } });
    assert.equal((await fetch(`${url}/extract`, { method: 'POST', body: 'bad' })).status, 415);
    const response = await fetch(`${url}/extract`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-fixture' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: '%PDF-fixture', pageCount: 1 });
    assert.equal((await fetch(`${url}/missing`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('HTTP OCR contract accepts only PNG, JPEG, or PDF and returns bounded JSON', async () => {
  const seen = [];
  const server = createServer({
    extractPdf: async bytes => ({ text: bytes.toString(), pageCount: 1 }),
    ocrImage: async (bytes, mime) => { seen.push(mime); return { text: String(bytes.length), pageCount: 1, ocr: true }; },
    ocrPdf: async () => ({ text: 'scanned', pageCount: 2, ocr: true }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/ocr`, { method: 'POST', headers: { 'Content-Type': 'image/gif' }, body: 'bad' })).status, 415);
    const image = await fetch(`${url}/ocr`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'png' });
    assert.equal(image.status, 200);
    assert.deepEqual(await image.json(), { text: '3', pageCount: 1, ocr: true });
    const pdf = await fetch(`${url}/ocr`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF' });
    assert.deepEqual(await pdf.json(), { text: 'scanned', pageCount: 2, ocr: true });
    assert.deepEqual(seen, ['image/png']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('graceful shutdown handlers close the HTTP server', () => {
  const handlers = {};
  const processRef = { once: (name, handler) => { handlers[name] = handler; } };
  const server = { close: assert.fn };
  let closes = 0;
  server.close = () => { closes += 1; };
  installShutdownHandlers(server, processRef);
  handlers.SIGTERM();
  handlers.SIGINT();
  assert.equal(closes, 2);
});

test('HTTP contract serializes busy and timeout states without internals', async () => {
  let release;
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const server = createServer(async () => {
    ready();
    await new Promise(resolve => { release = resolve; });
    throw new ProcessingError('PROCESSING_TIMEOUT');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = fetch(`${url}/extract`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-one' });
    await entered;
    const busy = await fetch(`${url}/extract`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-two' });
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { code: 'PROCESSOR_BUSY' });
    release();
    const timeout = await first;
    assert.equal(timeout.status, 504);
    assert.deepEqual(await timeout.json(), { code: 'PROCESSING_TIMEOUT' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
