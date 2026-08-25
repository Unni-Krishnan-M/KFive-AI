import { Schema, model } from 'mongoose';

const agentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', maxlength: 1000 },
  systemPrompt: { type: String, required: true, maxlength: 20000 },
  aiModel: { type: String, required: true, maxlength: 200 },
  temperature: { type: Number, min: 0, max: 2, default: 0.7 },
  tools: {
    type: [String],
    default: [],
    validate: [(value: string[]) => value.length === 0, 'Agent tools are not enabled.'],
  },
}, { timestamps: true });

agentSchema.index({ userId: 1, updatedAt: -1 });
agentSchema.index({ userId: 1, projectId: 1, updatedAt: -1 });

export const Agent = model('Agent', agentSchema);
