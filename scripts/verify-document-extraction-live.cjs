const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');

async function main() {
  assert.ok(process.argv.includes('--allow-live-test'), 'Pass --allow-live-test to create a dedicated test account and document.');
  const base = 'http://127.0.0.1:3002/api/v1';
  const name = `pdfcheck_${randomBytes(6).toString('hex')}`;
  const registration = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: randomBytes(24).toString('hex') }),
  });
  assert.equal(registration.status, 201);
  const token = (await registration.json()).data.accessToken;
  const headers = { Authorization: `Bearer ${token}` };
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const marker = `KFive isolated PDF ${name}`;
  pdf.addPage().drawText(marker, { font });
  const form = new FormData();
  form.append('document', new Blob([await pdf.save()], { type: 'application/pdf' }), 'verification.pdf');
  let id;
  try {
    const uploaded = await fetch(`${base}/documents`, { method: 'POST', headers, body: form });
    assert.equal(uploaded.status, 201);
    const upload = (await uploaded.json()).data;
    id = upload._id;
    assert.equal(upload.status, 'completed', JSON.stringify(upload));
    const detail = await fetch(`${base}/documents/${id}`, { headers });
    assert.equal(detail.status, 200);
    const document = (await detail.json()).data;
    assert.equal(document.pageCount, 1);
    assert.ok(document.content.includes(marker));
    assert.equal(document.path, undefined);
    const listed = (await (await fetch(`${base}/documents`, { headers })).json()).data;
    assert.ok(listed.some(item => item._id === id && item.status === 'completed'));
    assert.ok(listed.every(item => item.content === undefined && item.path === undefined));
    assert.equal((await fetch(`${base}/documents/${id}`)).status, 401);
    console.log(JSON.stringify({ passed: true, documentId: id, pageCount: document.pageCount, extracted: marker }));
  } finally {
    if (id) assert.equal((await fetch(`${base}/documents/${id}`, { method: 'DELETE', headers })).status, 200);
  }
  console.log('PASS: authenticated upload -> isolated processor -> persisted detail/list -> delete. Test account retained; document deleted.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
