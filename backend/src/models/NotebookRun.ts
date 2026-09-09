import { Schema, model } from 'mongoose';

export const NOTEBOOK_RUN_LIMITS = Object.freeze({
  retainedPerOwner: 100,
  pageSize: 25,
  maxPages: 10,
  timeline: 32,
  executedNotebookBytes: 5 * 1024 * 1024,
  artifactCount: 20,
  artifactBytesEach: 1024 * 1024,
  artifactBytesTotal: 4 * 1024 * 1024,
  metrics: 1_000,
});

export type NotebookRunStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'cancel-requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'resource_exceeded'
  | 'interrupted';

const cellSchema = new Schema({
  id: { type: String, required: true, maxlength: 64, match: /^[A-Za-z0-9_-]{1,64}$/ },
  type: { type: String, required: true, enum: ['code', 'markdown'] },
  source: { type: String, required: true, maxlength: 65_536 },
  tags: { type: [{ type: String, maxlength: 64 }], default: [] },
}, { _id: false, strict: 'throw' });

const timelineSchema = new Schema({
  revision: { type: Number, required: true, min: 1, max: 1_000_000 },
  sequence: { type: Number, required: true, min: 1, max: NOTEBOOK_RUN_LIMITS.timeline },
  type: {
    type: String,
    required: true,
    enum: ['created', 'started', 'verification_started', 'cancel_requested', 'completed', 'failed', 'cancelled', 'interrupted'],
  },
  timestamp: { type: Date, required: true },
  code: { type: String, maxlength: 100 },
}, { _id: false, strict: 'throw' });

const metricSchema = new Schema({
  name: { type: String, required: true, maxlength: 128 },
  value: { type: Number, required: true },
  step: { type: Number, min: 0, max: Number.MAX_SAFE_INTEGER },
}, { _id: false, strict: 'throw' });

const artifactSchema = new Schema({
  path: { type: String, required: true, maxlength: 256 },
  kind: { type: String, required: true, enum: ['text', 'json', 'png', 'jpeg'] },
  mimeType: { type: String, required: true, enum: ['text/plain; charset=utf-8', 'application/json', 'image/png', 'image/jpeg'] },
  bytes: { type: Number, required: true, min: 0, max: NOTEBOOK_RUN_LIMITS.artifactBytesEach },
  sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  data: {
    type: Buffer,
    required: true,
    validate: [(value: Buffer) => Buffer.isBuffer(value) && value.length <= NOTEBOOK_RUN_LIMITS.artifactBytesEach,
      'Notebook artifact exceeds its byte limit.'],
  },
}, { _id: false, strict: 'throw' });

const notebookRunSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  notebookId: { type: Schema.Types.ObjectId, ref: 'Notebook', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  notebookRevision: { type: Number, required: true, immutable: true, min: 1, max: 999_999 },
  snapshotSha256: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  cells: {
    type: [cellSchema], required: true, immutable: true,
    validate: [(value: unknown[]) => value.length >= 1 && value.length <= 32, 'Notebook run snapshot cell count is invalid.'],
  },
  cellTimeoutSeconds: { type: Number, required: true, immutable: true, min: 1, max: 30 },
  jobId: { type: String, required: true, immutable: true, maxlength: 100 },
  status: {
    type: String,
    required: true,
    index: true,
    default: 'queued',
    enum: ['queued', 'running', 'verifying', 'cancel-requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'resource_exceeded', 'interrupted'],
  },
  activeOwnerSlot: { type: Boolean, default: true },
  revision: { type: Number, required: true, min: 1, max: 1_000_000, default: 1 },
  executedNotebookJson: {
    type: String,
    validate: [(value: string | undefined) => value === undefined
      || Buffer.byteLength(value, 'utf8') <= NOTEBOOK_RUN_LIMITS.executedNotebookBytes,
    'Executed notebook exceeds its byte limit.'],
  },
  metrics: {
    type: [metricSchema], default: [],
    validate: [(value: unknown[]) => value.length <= NOTEBOOK_RUN_LIMITS.metrics, 'Notebook run has too many metrics.'],
  },
  artifacts: {
    type: [artifactSchema], default: [],
    validate: [(value: Array<{ bytes?: number }>) => value.length <= NOTEBOOK_RUN_LIMITS.artifactCount
      && value.reduce((total, item) => total + (item.bytes ?? 0), 0) <= NOTEBOOK_RUN_LIMITS.artifactBytesTotal,
    'Notebook run artifacts exceed their aggregate limit.'],
  },
  result: {
    durationMs: { type: Number, min: 0, max: 3_600_000 },
    runtimeImageId: { type: String, maxlength: 200 },
    verifierImageId: { type: String, maxlength: 200 },
  },
  error: {
    code: { type: String, maxlength: 100 },
    message: { type: String, maxlength: 300 },
    cellIndex: { type: Number, min: 0, max: 31 },
  },
  timeline: {
    type: [timelineSchema], default: [],
    validate: [(value: unknown[]) => value.length <= NOTEBOOK_RUN_LIMITS.timeline, 'Notebook run timeline is too large.'],
  },
  queuedAt: { type: Date, required: true, default: Date.now },
  startedAt: { type: Date },
  verificationStartedAt: { type: Date },
  cancelRequestedAt: { type: Date },
  completedAt: { type: Date },
  execution: {
    workerId: { type: String, maxlength: 120 },
    heartbeatAt: { type: Date },
    runtimeContainerId: { type: String, match: /^[a-f0-9]{12,64}$/ },
  },
}, { timestamps: true, strict: 'throw' });

notebookRunSchema.index({ ownerId: 1, notebookId: 1, createdAt: -1, _id: -1 });
notebookRunSchema.index({ ownerId: 1, projectId: 1, createdAt: -1, _id: -1 });
notebookRunSchema.index({ status: 1, updatedAt: 1 });
notebookRunSchema.index(
  { ownerId: 1 },
  { unique: true, partialFilterExpression: { activeOwnerSlot: true }, name: 'one_active_notebook_run_per_owner' }
);

export const NotebookRunModel = model('NotebookRun', notebookRunSchema);
