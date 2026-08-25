import { Schema, model } from 'mongoose';

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const messageSchema = new Schema<ConversationMessage>({
  role: { type: String, enum: ['system', 'user', 'assistant'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
}, { _id: true });

const conversationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  title: { type: String, required: true, trim: true, maxlength: 200, default: 'New Conversation' },
  messages: { type: [messageSchema], default: [] },
  settings: {
    model: { type: String, default: 'phi3' },
    provider: { type: String, default: 'ollama' },
    temperature: { type: Number, min: 0, max: 2, default: 0.7 },
    useRag: { type: Boolean, default: false },
  },
  agent: { type: Schema.Types.ObjectId, ref: 'Agent' },
  workspace: { type: Schema.Types.Mixed },
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
