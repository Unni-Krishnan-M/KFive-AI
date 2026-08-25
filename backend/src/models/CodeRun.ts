import { Schema, model } from 'mongoose';

export type CodeLanguage = 'python' | 'javascript';
export type CodeRunStatus =
  | 'queued'
  | 'running'
  | 'cancel-requested'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'resource_exceeded'
  | 'output_limit'
  | 'internal_error';

const resultSchema = new Schema({
  stdout: { type: String, default: '', maxlength: 1_048_576 },
  stderr: { type: String, default: '', maxlength: 1_048_576 },
  exitCode: { type: Number },
  signal: { type: String, maxlength: 50 },
  executionTimeMs: { type: Number, min: 0 },
  memoryUsedBytes: { type: Number, min: 0 },
  outputTruncated: { type: Boolean, default: false },
  oomKilled: { type: Boolean, default: false },
  errorCode: { type: String, maxlength: 100 },
  errorMessage: { type: String, maxlength: 2000 },
}, { _id: false });

const codeRunSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  language: { type: String, enum: ['python', 'javascript'], required: true, immutable: true },
  runtimeVersion: { type: String, required: true, immutable: true, maxlength: 50 },
  source: { type: String, required: true, immutable: true, maxlength: 65_536 },
  stdin: { type: String, default: '', immutable: true, maxlength: 16_384 },
  status: {
    type: String,
    enum: [
      'queued', 'running', 'cancel-requested', 'succeeded', 'failed', 'timed_out',
      'cancelled', 'resource_exceeded', 'output_limit', 'internal_error',
    ],
    required: true,
    default: 'queued',
    index: true,
  },
  limits: {
    timeoutMs: { type: Number, required: true, immutable: true },
    memoryBytes: { type: Number, required: true, immutable: true },
    cpus: { type: Number, required: true, immutable: true },
    pids: { type: Number, required: true, immutable: true },
    outputBytes: { type: Number, required: true, immutable: true },
    networkEnabled: { type: Boolean, required: true, immutable: true, default: false },
  },
  result: { type: resultSchema },
  queuedAt: { type: Date, required: true, default: Date.now },
  startedAt: { type: Date },
  completedAt: { type: Date },
  cancelRequestedAt: { type: Date },
}, { timestamps: true });

codeRunSchema.index({ userId: 1, createdAt: -1 });
codeRunSchema.index({ userId: 1, projectId: 1, createdAt: -1 });
codeRunSchema.index({ status: 1, queuedAt: 1 });

export const CodeRunModel = model('CodeRun', codeRunSchema);
