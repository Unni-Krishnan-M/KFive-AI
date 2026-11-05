const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { PDFDocument } = require('pdf-lib');

const execute = promisify(execFile);

async function makeFixture(outputPath) {
  const directory = await mkdtemp(join(tmpdir(), 'kfive-document-rag-'));
  try {
    const pages = [
      { path: join(directory, 'page-1.png'), marker: 'CEDAR PAGE ONE 92126' },
      { path: join(directory, 'page-2.png'), marker: 'ORCHID PAGE TWO 92126' },
    ];
    for (const page of pages) {
      await execute('convert', [
        '-size', '1800x500', 'xc:white', '-fill', 'black', '-font', 'DejaVu-Sans',
        '-pointsize', '96', '-gravity', 'center', '-annotate', '0', page.marker, page.path,
      ], { timeout: 10000 });
    }
    const pdf = await PDFDocument.create();
    for (const page of pages) {
      const embedded = await pdf.embedPng(await readFile(page.path));
      const pdfPage = pdf.addPage([embedded.width, embedded.height]);
      pdfPage.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
    await writeFile(outputPath, Buffer.from(await pdf.save()), { mode: 0o600 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function request(base, token, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  return { response, body };
}

async function register(base, prefix) {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: randomBytes(24).toString('hex') }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.accessToken;
}

async function main() {
  const fixtureIndex = process.argv.indexOf('--fixture-only');
  if (fixtureIndex >= 0) {
    const target = process.argv[fixtureIndex + 1];
    assert.ok(target, '--fixture-only requires an output path');
    await makeFixture(resolve(target));
    console.log(`Created ${resolve(target)}`);
    return;
  }
  assert.ok(process.argv.includes('--allow-live-test'), 'Pass --allow-live-test to create dedicated document/RAG fixtures.');
  const base = 'http://127.0.0.1:3002/api/v1';
  const directory = await mkdtemp(join(tmpdir(), 'kfive-document-rag-live-'));
  const fixture = join(directory, 'two-page-scan.pdf');
  let ownerToken;
  let documentId;
  let sourceId;
  try {
    await makeFixture(fixture);
    ownerToken = await register(base, 'dr_owner');
    const otherToken = await register(base, 'dr_other');
    const form = new FormData();
    form.append('document', new Blob([await readFile(fixture)], { type: 'application/pdf' }), 'two-page-scan.pdf');
    const upload = await request(base, ownerToken, '/documents', { method: 'POST', body: form });
    assert.equal(upload.response.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.data.status, 'completed');
    documentId = upload.body.data._id;

    const detail = await request(base, ownerToken, `/documents/${documentId}`);
    assert.equal(detail.body.data.ocrApplied, true);
    assert.equal(detail.body.data.pageCount, 2);
    assert.match(detail.body.data.content, /ORCHID PAGE TWO 92126/i);

    const indexed = await request(base, ownerToken, '/knowledge/sources/from-document', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId }),
    });
    assert.equal(indexed.response.status, 201, JSON.stringify(indexed.body));
    sourceId = indexed.body.data.source.id;
    assert.equal(indexed.body.data.source.documentId, documentId);
    assert.equal(indexed.body.data.source.pageCount, 2);

    const repeated = await request(base, ownerToken, '/knowledge/sources/from-document', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId }),
    });
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.body.data.created, false);
    assert.equal(repeated.body.data.source.id, sourceId);

    const denied = await request(base, otherToken, '/knowledge/sources/from-document', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId }),
    });
    assert.equal(denied.response.status, 404);

    const queried = await request(base, ownerToken, '/knowledge/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What exact phrase appears on page two?', topK: 5 }),
    });
    assert.equal(queried.response.status, 200, JSON.stringify(queried.body));
    const pageTwo = queried.body.data.references.find((reference) => reference.documentId === documentId
      && reference.pageStart === 2 && reference.pageEnd === 2);
    assert.ok(pageTwo, JSON.stringify(queried.body.data.references));
    assert.match(pageTwo.snippet, /ORCHID PAGE TWO 92126/i);

    console.log(JSON.stringify({ passed: true, documentId, sourceId, pageReference: 2 }));
  } finally {
    if (ownerToken && sourceId) await request(base, ownerToken, `/knowledge/sources/${sourceId}`, { method: 'DELETE' });
    if (ownerToken && documentId) await request(base, ownerToken, `/documents/${documentId}`, { method: 'DELETE' });
    await rm(directory, { recursive: true, force: true });
  }
  console.log('PASS: scanned PDF -> OCR -> stored document -> Ollama embeddings -> Chroma -> page-aware RAG query -> cleanup.');
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
