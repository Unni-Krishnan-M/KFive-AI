import { Schema, model } from 'mongoose';

const documentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  originalName: { type: String, required: true },
  filename: { type: String, required: true, unique: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true, min: 0 },
  path: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  content: { type: String, default: '' },
  errorMessage: { type: String },
}, { timestamps: true });

documentSchema.index({ userId: 1, createdAt: -1 });
documentSchema.index({ userId: 1, projectId: 1, createdAt: -1 });

export const DocumentModel = model('Document', documentSchema);
