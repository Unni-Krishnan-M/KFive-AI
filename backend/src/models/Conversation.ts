import { Schema, model } from 'mongoose';

export type ConversationGenerationStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'output_limit'
  | 'interrupted';

export interface ConversationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  loadDurationMs?: number;
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
  requestId?: string;
  status?: Exclude<ConversationGenerationStatus, 'running'>;
  provider?: string;
  model?: string;
  usage?: ConversationUsage;
  error?: { code: string; message: string };
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

const usageSchema = new Schema({
  inputTokens: { type: Number, min: 0, max: 100_000_000 },
  outputTokens: { type: Number, min: 0, max: 100_000_000 },
  totalTokens: { type: Number, min: 0, max: 200_000_000 },
  totalDurationMs: { type: Number, min: 0, max: 86_400_000 },
  loadDurationMs: { type: Number, min: 0, max: 86_400_000 },
}, { _id: false });

const generationErrorSchema = new Schema({
  code: {
    type: String,
    enum: [
      'CHAT_PROVIDER_UNAVAILABLE',
      'CHAT_TIMEOUT',
      'CHAT_GENERATION_FAILED',
      'CHAT_OUTPUT_LIMIT',
      'CHAT_CANCELLED',
      'CHAT_INTERRUPTED',
    ],
    required: true,
  },
  message: { type: String, required: true, maxlength: 300 },
}, { _id: false });

const messageSchema = new Schema<ConversationMessage>({
  role: { type: String, enum: ['system', 'user', 'assistant'], required: true },
  // Empty assistant content is intentional for a durable failed/cancelled turn.
  content: {
    type: String,
    default: '',
    validate: {
      validator(this: ConversationMessage, value: string) {
        if (Buffer.byteLength(value, 'utf8') > 256 * 1024) return false;
        if (this.role !== 'assistant') return value.length > 0;
        return value.length > 0 || (this.status !== undefined && this.status !== 'succeeded');
      },
      message: 'Message content is invalid or exceeds 262144 UTF-8 bytes.',
    },
  },
  timestamp: { type: Date, default: Date.now },
  requestId: { type: String, maxlength: 80 },
  status: {
    type: String,
    enum: ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'],
  },
  provider: { type: String, maxlength: 80 },
  model: { type: String, maxlength: 200 },
  usage: { type: usageSchema },
  error: { type: generationErrorSchema },
  durationMs: { type: Number, min: 0, max: 86_400_000 },
  timeToFirstTokenMs: { type: Number, min: 0, max: 86_400_000 },
}, { _id: true });

const generationSchema = new Schema({
  requestId: { type: String, required: true, maxlength: 80 },
  status: {
    type: String,
    enum: ['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'],
    required: true,
  },
  userMessageId: { type: Schema.Types.ObjectId, required: true },
  provider: { type: String, maxlength: 80 },
  model: { type: String, maxlength: 200 },
  outputBytes: { type: Number, min: 0, max: 256 * 1024, default: 0 },
  usage: { type: usageSchema },
  error: { type: generationErrorSchema },
  startedAt: { type: Date, required: true },
  deadlineAt: { type: Date, required: true },
  completedAt: { type: Date },
  durationMs: { type: Number, min: 0, max: 86_400_000 },
  timeToFirstTokenMs: { type: Number, min: 0, max: 86_400_000 },
}, { _id: false });

const conversationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  title: { type: String, required: true, trim: true, maxlength: 200, default: 'New Conversation' },
  messages: {
    type: [messageSchema],
    default: [],
    validate: {
      validator: (messages: ConversationMessage[]) => messages.length <= 64,
      message: 'Conversation message retention limit exceeded.',
    },
  },
  settings: {
    model: { type: String, maxlength: 200 },
    provider: { type: String, maxlength: 80 },
    temperature: { type: Number, min: 0, max: 2, default: 0.7 },
    useRag: { type: Boolean, default: false },
  },
  agent: { type: Schema.Types.ObjectId, ref: 'Agent' },
  workspace: { type: Schema.Types.Mixed },
  generation: { type: generationSchema },
  metadata: {
    totalTokens: { type: Number, default: 0, min: 0 },
    messageCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    isArchived: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
  },
}, { timestamps: true });

conversationSchema.index({ userId: 1, 'metadata.lastMessageAt': -1 });
conversationSchema.index({ userId: 1, projectId: 1, 'metadata.lastMessageAt': -1 });

export const Conversation = model('Conversation', conversationSchema);
