import { Types } from 'mongoose';
import { NotebookModel } from './Notebook';

function notebook() {
  return new NotebookModel({
    ownerId: new Types.ObjectId(),
    title: 'Analysis',
    cells: [
      { id: 'imports', type: 'code', source: 'x = 2', tags: [] },
      { id: 'notes', type: 'markdown', source: '## Notes', tags: ['report'] },
    ],
    cellTimeoutSeconds: 10,
    revision: 1,
  });
}

describe('Notebook model', () => {
  it('validates a bounded canonical notebook document', async () => {
    await expect(notebook().validate()).resolves.toBeUndefined();
  });

  it('persists a blank starter cell accepted by the notebook editor contract', async () => {
    const blank = notebook();
    blank.cells = [{ id: 'starter', type: 'code', source: '', tags: [] }] as any;
    await expect(blank.validate()).resolves.toBeUndefined();
    expect(blank.cells[0].source).toBe('');
  });

  it('rejects unsupported cells and persisted collection bounds', async () => {
    const invalidType = notebook();
    invalidType.cells[0].type = 'html' as any;
    await expect(invalidType.validate()).rejects.toThrow('not a valid enum');

    const noCells = notebook();
    noCells.cells = [] as any;
    await expect(noCells.validate()).rejects.toThrow('1 through 32');

    const tags = notebook();
    tags.cells[0].tags = Array.from({ length: 17 }, (_, index) => `tag-${index}`);
    await expect(tags.validate()).rejects.toThrow('safe, unique, and bounded');
  });

  it('rejects noncanonical ids, duplicate tags/cells, unsafe text, and total UTF-8 overflow', async () => {
    const invalidId = notebook(); invalidId.cells[0].id = '../bad';
    await expect(invalidId.validate()).rejects.toThrow('is invalid');
    const duplicateTags = notebook(); duplicateTags.cells[0].tags = ['same', 'same'];
    await expect(duplicateTags.validate()).rejects.toThrow('safe, unique, and bounded');
    const duplicateCells = notebook(); duplicateCells.cells[1].id = duplicateCells.cells[0].id;
    await expect(duplicateCells.validate()).rejects.toThrow('unique ids');
    const unsafe = notebook(); unsafe.cells[0].source = 'safe\u202Ehidden';
    await expect(unsafe.validate()).rejects.toThrow('canonical safe UTF-8');
    const oversized = notebook();
    oversized.cells = Array.from({ length: 5 }, (_, index) => ({
      id: `cell-${index}`, type: 'code', source: 'x'.repeat(60 * 1024), tags: [],
    })) as any;
    await expect(oversized.validate()).rejects.toThrow('document source limit');
  });

  it('declares immutable ownership/scope and owner/project indexes', () => {
    expect(NotebookModel.schema.path('ownerId').options.immutable).toBe(true);
    expect(NotebookModel.schema.path('projectId').options.immutable).toBe(true);
    expect(NotebookModel.schema.indexes().map(([fields]) => fields)).toEqual(expect.arrayContaining([
      { ownerId: 1, updatedAt: -1, _id: -1 },
      { ownerId: 1, projectId: 1, updatedAt: -1, _id: -1 },
    ]));
  });
});
