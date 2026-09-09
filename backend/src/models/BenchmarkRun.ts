import { Schema, model } from 'mongoose';

export type BenchmarkRunStatus =
  | 'queued'
  | 'running'
  | 'cancel-requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'output_limit'
  | 'interrupted';

export type BenchmarkTimelineType =
  | 'created'
  | 'started'
  | 'provider_selected'
  | 'call_started'
  | 'call_completed'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

const usageSchema = new Schema({
  inputTokens: { type: Number, min: 0, max: 100_000_000 },
  outputTokens: { type: Number, min: 0, max: 100_000_000 },
  totalTokens: { type: Number, min: 0, max: 200_000_000 },
  totalDurationMs: { type: Number, min: 0, max: 86_400_000 },
  loadDurationMs: { type: Number, min: 0, max: 86_400_000 },
}, { _id: false });

const modelIdentitySchema = new Schema({
  id: { type: String, required: true, maxlength: 200 },
  digest: { type: String, maxlength: 200 },
  sizeBytes: { type: Number, min: 0, max: Number.MAX_SAFE_INTEGER },
  contextWindow: { type: Number, min: 0, max: 100_000_000 },
}, { _id: false });

const resultSchema = new Schema({
  callIndex: { type: Number, required: true, min: 0, max: 5 },
  promptIndex: { type: Number, required: true, min: 0, max: 2 },
  repetition: { type: Number, required: true, min: 1, max: 2 },
  promptLength: { type: Number, required: true, min: 1, max: 16_384 },
  passed: { type: Boolean, required: true },
  output: { type: String, default: '', maxlength: 16_384 },
  outputBytes: { type: Number, required: true, min: 0, max: 16_384 },
  durationMs: { type: Number, required: true, min: 0, max: 180_000 },
  ttftMs: { type: Number, min: 0, max: 180_000 },
  provider: { type: String, required: true, maxlength: 100 },
  model: { type: String, required: true, maxlength: 200 },
  usage: { type: usageSchema },
  finishReason: { type: String, enum: ['stop', 'length', 'error', 'unknown'] },
  error: {
    code: { type: String, maxlength: 100 },
    message: { type: String, maxlength: 300 },
  },
}, { _id: false });

const gpuDeviceSchema = new Schema({
  index: { type: Number, required: true, min: 0, max: 1024 },
  name: { type: String, required: true, maxlength: 120 },
  driverVersion: { type: String, required: true, maxlength: 80 },
  memoryTotalMiB: { type: Number, required: true, min: 0, max: 10_000_000 },
  memoryUsedMiB: { type: Number, required: true, min: 0, max: 10_000_000 },
  memoryFreeMiB: { type: Number, required: true, min: 0, max: 10_000_000 },
  utilizationPercent: { type: Number, required: true, min: 0, max: 100 },
  temperatureC: { type: Number, required: true, min: 0, max: 300 },
}, { _id: false, strict: 'throw' });

const gpuSnapshotSchema = new Schema({
  available: { type: Boolean, required: true },
  reason: {
    type: String,
    enum: ['nvidia-smi-not-found', 'probe-timeout', 'driver-unavailable', 'malformed-output', 'no-nvidia-gpu'],
  },
  sampledAt: { type: String, required: true, maxlength: 40 },
  devices: {
    type: [gpuDeviceSchema],
    default: [],
    validate: [(value: unknown[]) => value.length <= 8, 'Benchmark GPU snapshot has too many devices.'],
  },
  summary: {
    deviceCount: { type: Number, min: 0, max: 8 },
    totalVramMiB: { type: Number, min: 0, max: 10_000_000 },
    usedVramMiB: { type: Number, min: 0, max: 10_000_000 },
    freeVramMiB: { type: Number, min: 0, max: 10_000_000 },
  },
}, { _id: false, strict: 'throw' });

const timelineSchema = new Schema({
  revision: { type: Number, required: true, min: 1, max: 1_000_000 },
  sequence: { type: Number, required: true, min: 1, max: 50 },
  type: {
    type: String,
    required: true,
    enum: ['created', 'started', 'provider_selected', 'call_started', 'call_completed', 'cancel_requested', 'completed', 'failed', 'cancelled'],
  },
  timestamp: { type: Date, required: true },
  callIndex: { type: Number, min: 0, max: 5 },
  provider: { type: String, maxlength: 100 },
  model: { type: String, maxlength: 200 },
  code: { type: String, maxlength: 100 },
}, { _id: false });

const benchmarkRunSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  suite: {
    id: { type: String, required: true, immutable: true, enum: ['chat-core-v1'] },
    version: { type: Number, required: true, immutable: true, enum: [1] },
    promptCount: { type: Number, required: true, immutable: true, enum: [3] },
    repetitions: { type: Number, required: true, immutable: true, enum: [2] },
    totalCalls: { type: Number, required: true, immutable: true, enum: [6] },
  },
  provider: { type: String, maxlength: 100 },
  jobId: { type: String, required: true, immutable: true, maxlength: 100 },
  activeOwnerSlot: { type: Boolean, default: true },
  revision: { type: Number, required: true, min: 1, max: 1_000_000, default: 1 },
  model: {
    requested: { type: modelIdentitySchema, required: true, immutable: true },
    actual: { type: modelIdentitySchema },
  },
  status: {
    type: String,
    required: true,
    index: true,
    default: 'queued',
    enum: ['queued', 'running', 'cancel-requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'],
  },
  results: {
    type: [resultSchema],
    default: [],
    validate: [(value: unknown[]) => value.length <= 6, 'Benchmark run has too many call results.'],
  },
  completedCalls: { type: Number, required: true, min: 0, max: 6, default: 0 },
  passedCalls: { type: Number, required: true, min: 0, max: 6, default: 0 },
  outputBytes: { type: Number, required: true, min: 0, max: 131_072, default: 0 },
  wallDurationMs: { type: Number, min: 0, max: 180_000 },
  aggregate: {
    passCount: { type: Number, min: 0, max: 6 },
    totalCalls: { type: Number, enum: [6] },
    medianTtftMs: { type: Number, min: 0, max: 180_000 },
    medianDurationMs: { type: Number, min: 0, max: 180_000 },
    medianOutputBytes: { type: Number, min: 0, max: 16_384 },
    outputTokens: { type: Number, min: 0, max: 600_000_000 },
    outputTokensPerSecond: { type: Number, min: 0, max: 1_000_000_000 },
  },
  gpu: {
    before: { type: gpuSnapshotSchema },
    after: { type: gpuSnapshotSchema },
  },
  error: {
    code: {
      type: String,
      enum: ['BENCHMARK_PROVIDER_UNAVAILABLE', 'BENCHMARK_CALL_FAILED', 'BENCHMARK_TIMEOUT', 'BENCHMARK_EXECUTION_FAILED', 'BENCHMARK_OUTPUT_LIMIT', 'BENCHMARK_INTERRUPTED'],
    },
    message: { type: String, maxlength: 300 },
  },
  timeline: {
    type: [timelineSchema],
    default: [],
    validate: [(value: unknown[]) => value.length <= 50, 'Benchmark timeline is too large.'],
  },
  queuedAt: { type: Date, required: true, default: Date.now },
  startedAt: { type: Date },
  cancelRequestedAt: { type: Date },
  completedAt: { type: Date },
  execution: {
    fence: { type: Number, min: 1, max: Number.MAX_SAFE_INTEGER },
    leaseOwner: { type: String, maxlength: 120 },
    heartbeatAt: { type: Date },
    inFlightCallIndex: { type: Number, min: 0, max: 5 },
  },
}, { timestamps: true });

benchmarkRunSchema.index({ ownerId: 1, createdAt: -1 });
benchmarkRunSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
benchmarkRunSchema.index({ status: 1, updatedAt: 1 });
benchmarkRunSchema.index(
  { ownerId: 1 },
  { unique: true, partialFilterExpression: { activeOwnerSlot: true }, name: 'one_active_benchmark_per_owner' }
);

export const BenchmarkRunModel = model('BenchmarkRun', benchmarkRunSchema);
