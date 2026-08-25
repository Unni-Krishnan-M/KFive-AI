import { Schema, model } from 'mongoose';

export type RagSourceStatus = 'indexing' | 'ready' | 'failed';
export type RagSourceMediaType = 'text/plain' | 'text/markdown';
export type RagSourceErrorCode =
  | 'RAG_PROVIDER_UNAVAILABLE'
  | 'RAG_VECTOR_STORE_UNAVAILABLE'
  | 'RAG_INGESTION_FAILED';

const ragSourceSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
  mediaType: { type: String, enum: ['text/plain', 'text/markdown'], required: true },
  status: { type: String, enum: ['indexing', 'ready', 'failed'], required: true, default: 'indexing' },
  characterCount: { type: Number, required: true, min: 1, max: 65_536 },
  byteCount: { type: Number, required: true, min: 1, max: 65_536 },
  chunkCount: { type: Number, required: true, min: 0, max: 64, default: 0 },
  chunkingVersion: { type: Number, required: true, immutable: true, enum: [1], default: 1 },
  contentHash: { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ },
  embeddingProvider: { type: String, trim: true, maxlength: 100 },
  embeddingModel: { type: String, trim: true, maxlength: 200 },
  embeddingDimension: { type: Number, min: 1, max: 8192 },
  collectionId: { type: String, trim: true, maxlength: 200 },
  collectionName: { type: String, trim: true, maxlength: 63 },
  errorCode: {
    type: String,
    enum: ['RAG_PROVIDER_UNAVAILABLE', 'RAG_VECTOR_STORE_UNAVAILABLE', 'RAG_INGESTION_FAILED'],
  },
  indexedAt: { type: Date },
}, { timestamps: true });

ragSourceSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
ragSourceSchema.index({ ownerId: 1, status: 1, updatedAt: -1 });
ragSourceSchema.index({ ownerId: 1, contentHash: 1, embeddingProvider: 1, embeddingModel: 1 });

export const RagSourceModel = model('RagSource', ragSourceSchema);
