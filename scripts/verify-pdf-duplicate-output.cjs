const { PDFDocument } = require('pdf-lib');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const directory = path.resolve(__dirname, '../output/verification');
  const source = await PDFDocument.load(await fs.readFile(path.join(directory, 'pdf-reorder/source.pdf')));
  const output = await PDFDocument.load(await fs.readFile(path.join(directory, 'pdf-duplicate-download.pdf')));
  const geometry = pdf => pdf.getPages().map(page => [page.getWidth(), page.getHeight(), page.getRotation().angle]);
  const expected = [[100, 200, 90], [200, 300, 0], [300, 400, 180], [400, 500, 270]];
  assert.deepEqual(geometry(source), expected);
  assert.deepEqual(geometry(output), [expected[0], expected[0], expected[1], expected[2], expected[2], expected[3]]);
  console.log(JSON.stringify({ passed: true, pages: 6, order: [1, 1, 2, 3, 3, 4], rotationsPreserved: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
