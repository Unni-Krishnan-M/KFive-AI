// Disposable fixture generation and independent verification of a browser download.
const { PDFDocument, degrees } = require('pdf-lib');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '../output/verification/pdf-reorder');
const expectedSource = [[100, 200, 90], [200, 300, 0], [300, 400, 180], [400, 500, 270]];
const geometry = pdf => pdf.getPages().map(page => [page.getWidth(), page.getHeight(), page.getRotation().angle]);
async function main() {
  if (process.argv[2] === '--fixture') {
    await fs.mkdir(directory, { recursive: true });
    const pdf = await PDFDocument.create();
    for (const [width, height, rotation] of expectedSource) pdf.addPage([width, height]).setRotation(degrees(rotation));
    await fs.writeFile(path.join(directory, 'source.pdf'), await pdf.save(), { flag: 'wx' });
    console.log('Created four-page reorder fixture without overwriting existing files.');
    return;
  }
  assert.equal(process.argv[2], '--verify', 'Use --fixture or --verify.');
  const source = await PDFDocument.load(await fs.readFile(path.join(directory, 'source.pdf')));
  const result = await PDFDocument.load(await fs.readFile(path.join(directory, 'download.pdf')));
  assert.deepEqual(geometry(source), expectedSource);
  assert.deepEqual(geometry(result), [expectedSource[3], expectedSource[1], expectedSource[0], expectedSource[2]]);
  console.log(JSON.stringify({ passed: true, order: [4, 2, 1, 3], pages: result.getPageCount(), sourceGeometryPreserved: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
