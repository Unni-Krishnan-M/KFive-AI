import { Schema, model } from 'mongoose';
import { WORKFLOW_SCHEMA_VERSION, isExactWorkflowDefinition, workflowDefinitionSchema } from './Workflow';

export type WorkflowRunStatus =
  | 'queued' | 'running' | 'cancel-requested' | 'succeeded' | 'failed'
  | 'cancelled' | 'timed_out' | 'output_limit' | 'interrupted';

export type WorkflowRunTimelineType =
  | 'created' | 'started' | 'provider_selected' | 'cancel_requested'
  | 'completed' | 'failed' | 'cancelled';

const usageSchema = new Schema({
  inputTokens: { type: Number, min: 0, max: 100_000_000 },
  outputTokens: { type: Number, min: 0, max: 100_000_000 },
  totalTokens: { type: Number, min: 0, max: 200_000_000 },
  totalDurationMs: { type: Number, min: 0, max: 86_400_000 },
  loadDurationMs: { type: Number, min: 0, max: 86_400_000 },
}, { _id: false, strict: 'throw' });

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
}, { _id: false, strict: 'throw' });

const workflowRunSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true, immutable: true, index: true },
  workflowSnapshot: {
    name: { type: String, required: true, maxlength: 120 },
    schemaVersion: { type: Number, required: true, enum: [WORKFLOW_SCHEMA_VERSION] },
    revision: { type: Number, required: true, min: 1, max: 1_000_000 },
    definition: {
      type: workflowDefinitionSchema,
      required: true,
      validate: { validator: isExactWorkflowDefinition, message: 'Workflow run definition snapshot is invalid.' },
    },
  },
  input: { type: String, required: true, maxlength: 16_384 },
  status: {
    type: String,
    required: true,
    default: 'queued',
    index: true,
    enum: ['queued', 'running', 'cancel-requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'],
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
      enum: ['WORKFLOW_PROVIDER_UNAVAILABLE', 'WORKFLOW_TIMEOUT', 'WORKFLOW_EXECUTION_FAILED', 'WORKFLOW_OUTPUT_LIMIT', 'WORKFLOW_INTERRUPTED'],
    },
    message: { type: String, maxlength: 300 },
  },
  timeline: {
    type: [timelineSchema],
    default: [],
    validate: [(value: unknown[]) => value.length <= 50, 'Workflow run timeline is too large.'],
  },
  queuedAt: { type: Date, required: true, default: Date.now },
  startedAt: { type: Date },
  cancelRequestedAt: { type: Date },
  completedAt: { type: Date },
}, { timestamps: true, strict: 'throw' });

workflowRunSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
workflowRunSchema.index({ ownerId: 1, workflowId: 1, createdAt: -1 });
workflowRunSchema.index({ status: 1, updatedAt: 1 });
workflowRunSchema.pre('validate', function validateExactSnapshot() {
  if (!isExactWorkflowDefinition(this.workflowSnapshot?.definition)) {
    this.invalidate('workflowSnapshot.definition', 'Workflow run definition snapshot is invalid.');
  }
});

export const WorkflowRunModel = model('WorkflowRun', workflowRunSchema);
