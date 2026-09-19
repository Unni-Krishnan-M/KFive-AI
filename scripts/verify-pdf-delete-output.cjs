// Generate and validate disposable browser-QA artifacts, never user PDFs.
const { PDFDocument, degrees } = require('pdf-lib');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const directory = path.resolve(__dirname, '../output/verification/pdf-delete');
async function main() {
  if (process.argv[2] === '--fixture') {
    await fs.mkdir(directory, { recursive: true });
    const pdf = await PDFDocument.create();
    for (const [width, height, rotation] of [[100, 200, 90], [200, 300, 0], [300, 400, 180], [400, 500, 270]]) {
      pdf.addPage([width, height]).setRotation(degrees(rotation));
    }
    await fs.writeFile(path.join(directory, 'source.pdf'), await pdf.save());
    console.log('Created four-page disposable PDF fixture.');
    return;
  }
  if (process.argv[2] !== '--verify') throw new Error('Use --fixture or --verify.');
  const result = await PDFDocument.load(await fs.readFile(path.join(directory, 'download.pdf')));
  const source = await PDFDocument.load(await fs.readFile(path.join(directory, 'source.pdf')));
  assert.equal(source.getPageCount(), 4);
  assert.deepEqual(result.getPages().map(page => [page.getWidth(), page.getHeight(), page.getRotation().angle]), [[100, 200, 90], [300, 400, 180]]);
  console.log(JSON.stringify({ passed: true, downloadedPages: 2, sourcePages: 4, retainedOrderAndRotations: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
