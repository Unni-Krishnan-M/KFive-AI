// Read-only comparison of deployed worker artifacts with the local build.
const { readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const base = new URL(process.argv[2] || 'http://127.0.0.1:3002');
  assert(['http:', 'https:'].includes(base.protocol), 'Use an HTTP(S) application origin.');
  assert(!base.username && !base.password, 'Credentials must not be embedded in the URL.');
  const report = [];
  for (const filename of ['sw.js', 'sw-private-cache-cleanup.js']) {
    const local = await readFile(path.resolve(__dirname, '../frontend/dist', filename));
    const response = await fetch(new URL(`/${filename}`, base), { signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert.equal(response.status, 200, `${filename} must be served successfully.`);
    assert.match(response.headers.get('content-type') || '', /(?:javascript|ecmascript)/i, `${filename} must not receive the HTML fallback.`);
    const deployed = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(deployed, local, `${filename} differs from the verified local build.`);
    report.push({ file: filename, sha256: createHash('sha256').update(deployed).digest('hex') });
  }
  console.log(JSON.stringify({ passed: true, artifacts: report }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
