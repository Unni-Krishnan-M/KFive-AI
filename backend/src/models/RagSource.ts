import { Schema, model } from 'mongoose';

export const RAG_MAX_SOURCES_PER_OWNER = 200;
export const RAG_QUOTA_INDEX_NAME = 'rag_owner_quota_slot_unique_v1';

export type RagSourceStatus = 'queued' | 'indexing' | 'ready' | 'failed';
export type RagSourceMediaType = 'text/plain' | 'text/markdown' | 'application/pdf' | 'image/png' | 'image/jpeg';
export type RagSourceErrorCode =
  | 'RAG_PROVIDER_UNAVAILABLE'
  | 'RAG_VECTOR_STORE_UNAVAILABLE'
  | 'RAG_INGESTION_FAILED';

const ragSourceSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  quotaSlot: { type: Number, min: 0, max: RAG_MAX_SOURCES_PER_OWNER - 1, immutable: true, select: false,
    validate: { validator: (value: number | undefined) => value === undefined || Number.isInteger(value), message: 'Invalid knowledge quota slot' } },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  sourceKind: { type: String, enum: ['text', 'document'], required: true, immutable: true, default: 'text' },
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', immutable: true },
  documentPageCount: { type: Number, min: 1, max: 500, immutable: true },
  documentOcrApplied: { type: Boolean, immutable: true },
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
  mediaType: { type: String, enum: ['text/plain', 'text/markdown', 'application/pdf', 'image/png', 'image/jpeg'], required: true },
  status: { type: String, enum: ['queued', 'indexing', 'ready', 'failed'], required: true, default: 'indexing' },
  characterCount: { type: Number, required: true, min: 1, max: 65_536 },
  byteCount: { type: Number, required: true, min: 1, max: 65_536 },
  chunkCount: { type: Number, required: true, min: 0, max: 64, default: 0 },
  chunkingVersion: { type: Number, required: true, immutable: true, enum: [1], default: 1 },
  contentHash: { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ },
  // Private retry input. Explicitly selected only by the indexing worker; legacy rows may omit it.
  contentSnapshot: {
    type: String, select: false,
    validate: {
      validator: (value: string | undefined) => value === undefined
        || (value.length > 0 && Buffer.byteLength(value, 'utf8') <= 65_536),
      message: 'Knowledge indexing snapshot exceeds the UTF-8 source limit.',
    },
  },
  embeddingProvider: { type: String, trim: true, maxlength: 100 },
  embeddingModel: { type: String, trim: true, maxlength: 200 },
  embeddingDimension: { type: Number, min: 1, max: 8192 },
  collectionId: { type: String, trim: true, maxlength: 200 },
  collectionName: { type: String, trim: true, maxlength: 63 },
  errorCode: {
    type: String,
    enum: ['RAG_PROVIDER_UNAVAILABLE', 'RAG_VECTOR_STORE_UNAVAILABLE', 'RAG_INGESTION_FAILED'],
  },
  indexingLease: {
    type: new Schema({ token: { type: String, maxlength: 36 }, attempt: { type: Number, min: 0, max: 3 }, expiresAt: Date }, { _id: false }),
    select: false,
  },
  indexingGeneration: { type: String, maxlength: 36 },
  indexedAt: { type: Date },
}, { timestamps: true });

ragSourceSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
ragSourceSchema.index({ ownerId: 1, status: 1, updatedAt: -1 });
ragSourceSchema.index({ ownerId: 1, contentHash: 1, embeddingProvider: 1, embeddingModel: 1 });
ragSourceSchema.index(
  { ownerId: 1, documentId: 1 },
  { unique: true, partialFilterExpression: { documentId: { $type: 'objectId' } } }
);

ragSourceSchema.index({ ownerId: 1, projectId: 1, _id: -1 });
ragSourceSchema.index({ status: 1, updatedAt: 1, _id: 1 });
ragSourceSchema.index({ ownerId: 1, quotaSlot: 1 }, {
  name: RAG_QUOTA_INDEX_NAME, unique: true, partialFilterExpression: { quotaSlot: { $type: 'number' } },
});

export const RagSourceModel = model('RagSource', ragSourceSchema);
