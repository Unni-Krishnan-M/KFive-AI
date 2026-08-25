import { Schema, model } from 'mongoose';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'cancel-requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'output_limit'
  | 'interrupted';

export type AgentRunTimelineType =
  | 'created'
  | 'started'
  | 'provider_selected'
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

const timelineSchema = new Schema({
  sequence: { type: Number, required: true, min: 1, max: 50 },
  type: {
    type: String,
    required: true,
    enum: ['created', 'started', 'provider_selected', 'cancel_requested', 'completed', 'failed', 'cancelled'],
  },
  timestamp: { type: Date, required: true },
  provider: { type: String, maxlength: 100 },
  model: { type: String, maxlength: 200 },
  code: { type: String, maxlength: 100 },
}, { _id: false });

const agentRunSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, immutable: true, index: true },
  agentSnapshot: {
    name: { type: String, required: true, maxlength: 100 },
    systemPromptHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    requestedModel: { type: String, required: true, maxlength: 200 },
    temperature: { type: Number, required: true, min: 0, max: 2 },
    tools: {
      type: [String],
      default: [],
      validate: [(value: string[]) => value.length === 0, 'Agent run tools must be empty.'],
    },
  },
  prompt: { type: String, required: true, maxlength: 16_384 },
  status: {
    type: String,
    enum: ['queued', 'running', 'cancel-requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'],
    required: true,
    default: 'queued',
    index: true,
  },
  provider: { type: String, maxlength: 100 },
  model: { type: String, maxlength: 200 },
  output: { type: String, default: '', maxlength: 262_144 },
  outputBytes: { type: Number, required: true, min: 0, max: 262_144, default: 0 },
  outputTruncated: { type: Boolean, required: true, default: false },
  usage: { type: usageSchema },
  finishReason: { type: String, enum: ['stop', 'length', 'error', 'unknown'] },
  error: {
    code: {
      type: String,
      enum: ['AGENT_PROVIDER_UNAVAILABLE', 'AGENT_TIMEOUT', 'AGENT_EXECUTION_FAILED', 'AGENT_OUTPUT_LIMIT', 'AGENT_INTERRUPTED'],
    },
    message: { type: String, maxlength: 300 },
  },
  timeline: {
    type: [timelineSchema],
    validate: [(value: unknown[]) => value.length <= 50, 'Agent run timeline is too large.'],
    default: [],
  },
  queuedAt: { type: Date, required: true, default: Date.now },
  startedAt: { type: Date },
  cancelRequestedAt: { type: Date },
  completedAt: { type: Date },
}, { timestamps: true });

agentRunSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
agentRunSchema.index({ ownerId: 1, agentId: 1, createdAt: -1 });
agentRunSchema.index({ status: 1, updatedAt: 1 });

export const AgentRunModel = model('AgentRun', agentRunSchema);
