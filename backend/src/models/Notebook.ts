import { Schema, model } from 'mongoose';

export const NOTEBOOK_LIMITS = Object.freeze({
  cells: 32,
  cellSourceBytes: 64 * 1024,
  totalSourceBytes: 256 * 1024,
  titleBytes: 120,
  tagsPerCell: 16,
  tagBytes: 64,
  timeoutSeconds: 30,
  retainedPerOwner: 100,
  pageSize: 25,
  maxPages: 10,
});

export type NotebookCellType = 'code' | 'markdown';
export interface NotebookCell { id: string; type: NotebookCellType; source: string; tags: string[] }

const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TAG = /^[A-Za-z0-9_.:-]{1,64}$/;
const unsafeText = (value: string): boolean => [...value].some((character) => {
  const point = character.codePointAt(0) ?? 0;
  return point === 0xfffd || /\p{Cf}/u.test(character)
    || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
});

const cellSchema = new Schema({
  id: { type: String, required: true, maxlength: 64, match: CELL_ID },
  type: { type: String, required: true, enum: ['code', 'markdown'] },
  source: {
    // Blank cells are valid editor state. A default preserves the field while
    // avoiding Mongoose's String `required` rule, which rejects an empty string.
    type: String, default: '', maxlength: NOTEBOOK_LIMITS.cellSourceBytes,
    validate: [(value: string) => Buffer.byteLength(value, 'utf8') <= NOTEBOOK_LIMITS.cellSourceBytes && !unsafeText(value),
      'Notebook cell source is not canonical safe UTF-8 text.'],
  },
  tags: {
    type: [{ type: String, maxlength: NOTEBOOK_LIMITS.tagBytes }], default: [],
    validate: [(value: unknown[]) => value.length <= NOTEBOOK_LIMITS.tagsPerCell
      && value.every((tag) => typeof tag === 'string' && TAG.test(tag)) && new Set(value).size === value.length,
    'Notebook cell tags must be safe, unique, and bounded.'],
  },
}, { _id: false, strict: 'throw' });

const notebookSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  title: {
    type: String, required: true, trim: true, minlength: 1, maxlength: NOTEBOOK_LIMITS.titleBytes,
    validate: [(value: string) => Buffer.byteLength(value, 'utf8') <= NOTEBOOK_LIMITS.titleBytes && !unsafeText(value),
      'Notebook title is not canonical safe UTF-8 text.'],
  },
  cells: {
    type: [cellSchema], required: true,
    validate: [(value: NotebookCell[]) => value.length >= 1 && value.length <= NOTEBOOK_LIMITS.cells
      && new Set(value.map((cell) => cell.id)).size === value.length
      && value.reduce((total, cell) => total + Buffer.byteLength(cell.source, 'utf8'), 0) <= NOTEBOOK_LIMITS.totalSourceBytes,
    'Notebook must contain 1 through 32 cells with unique ids within the document source limit.'],
  },
  cellTimeoutSeconds: { type: Number, required: true, min: 1, max: NOTEBOOK_LIMITS.timeoutSeconds, default: 10 },
  revision: { type: Number, required: true, min: 1, max: 999_999, default: 1 },
}, { timestamps: true, strict: 'throw' });

notebookSchema.index({ ownerId: 1, updatedAt: -1, _id: -1 });
notebookSchema.index({ ownerId: 1, projectId: 1, updatedAt: -1, _id: -1 });

export const NotebookModel = model('Notebook', notebookSchema);
