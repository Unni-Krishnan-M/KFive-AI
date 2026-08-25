import { Schema, model } from 'mongoose';

const treeEntrySchema = new Schema({
  path: { type: String, required: true, maxlength: 512 },
  type: { type: String, required: true, enum: ['file', 'directory'] },
  declaredBytes: { type: Number, min: 0, max: 26_214_400 },
  language: { type: String, maxlength: 40 },
}, { _id: false });

const languageSchema = new Schema({
  name: { type: String, required: true, maxlength: 40 },
  files: { type: Number, required: true, min: 1, max: 2000 },
  declaredBytes: { type: Number, required: true, min: 0, max: 26_214_400 },
}, { _id: false });

const manifestSchema = new Schema({
  path: { type: String, required: true, maxlength: 512 },
  packageName: { type: String, maxlength: 214 },
  packageManager: { type: String, required: true, enum: ['npm'] },
  dependencyCount: { type: Number, required: true, min: 0, max: 500 },
  scriptNames: [{ type: String, maxlength: 100 }],
}, { _id: false });

const dependencySchema = new Schema({
  manifestPath: { type: String, required: true, maxlength: 512 },
  name: { type: String, required: true, maxlength: 214 },
  version: { type: String, required: true, maxlength: 300 },
  kind: { type: String, required: true, enum: ['runtime', 'development', 'peer', 'optional'] },
}, { _id: false });

const frameworkSchema = new Schema({
  name: { type: String, required: true, maxlength: 80 },
  dependency: { type: String, required: true, maxlength: 214 },
  manifestPath: { type: String, required: true, maxlength: 512 },
}, { _id: false });

const signalSchema = new Schema({
  kind: { type: String, required: true, enum: ['tests', 'docker', 'compose', 'ci', 'kubernetes', 'security'] },
  path: { type: String, required: true, maxlength: 512 },
  severity: { type: String, enum: ['info', 'warning'] },
}, { _id: false });

const warningSchema = new Schema({
  code: { type: String, required: true, maxlength: 80 },
  message: { type: String, required: true, maxlength: 300 },
  path: { type: String, maxlength: 512 },
}, { _id: false });

const repositoryAnalysisSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
  status: { type: String, required: true, immutable: true, enum: ['completed'], default: 'completed' },
  analyzerVersion: { type: Number, required: true, immutable: true, enum: [1], default: 1 },
  source: {
    kind: { type: String, required: true, immutable: true, enum: ['zip'] },
    originalName: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true, maxlength: 100 },
    compressedBytes: { type: Number, required: true, min: 1, max: 10_485_760 },
    sha256: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  },
  summary: {
    fileCount: { type: Number, required: true, min: 0, max: 2000 },
    directoryCount: { type: Number, required: true, min: 0, max: 2000 },
    declaredUncompressedBytes: { type: Number, required: true, min: 0, max: 26_214_400 },
    maxDepth: { type: Number, required: true, min: 0, max: 30 },
    packageManifestCount: { type: Number, required: true, min: 0, max: 20 },
    testFileCount: { type: Number, required: true, min: 0, max: 2000 },
  },
  tree: { type: [treeEntrySchema], validate: [(v: unknown[]) => v.length <= 2000, 'Tree is too large.'] },
  languages: { type: [languageSchema], validate: [(v: unknown[]) => v.length <= 100, 'Language list is too large.'] },
  manifests: { type: [manifestSchema], validate: [(v: unknown[]) => v.length <= 20, 'Manifest list is too large.'] },
  dependencies: { type: [dependencySchema], validate: [(v: unknown[]) => v.length <= 500, 'Dependency list is too large.'] },
  frameworks: { type: [frameworkSchema], validate: [(v: unknown[]) => v.length <= 100, 'Framework list is too large.'] },
  signals: { type: [signalSchema], validate: [(v: unknown[]) => v.length <= 100, 'Signal list is too large.'] },
  warnings: { type: [warningSchema], validate: [(v: unknown[]) => v.length <= 100, 'Warning list is too large.'] },
}, { timestamps: true });

repositoryAnalysisSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
repositoryAnalysisSchema.index({ ownerId: 1, createdAt: -1 });

export const RepositoryAnalysisModel = model('RepositoryAnalysis', repositoryAnalysisSchema);
