import { RepositoryAnalysisModel } from '@/models/RepositoryAnalysis';
import { ProjectModel } from '@/models/Project';
import mongoose from 'mongoose';
import { ProjectError, ProjectService, projectService } from '@/services/projectService';
import { ProjectMutationLease, projectMutationLease } from '@/services/projectMutationLease';
import { REPOSITORY_LIMITS, RepositoryArchiveError, RepositoryArchiveReport } from './repositoryArchiveAnalyzer';
import { analyzeRepositoryZipIsolated } from './repositoryArchiveIsolation';
import {
  RepositoryImporterBusyError,
  RepositoryImporterUnavailableError,
  repositoryImporterAnalyzerFromEnvironment,
} from './repositoryImporterClient';

export type RepositoryAnalysisErrorCode = 'INVALID_REPOSITORY_INPUT' | 'REPOSITORY_ANALYSIS_NOT_FOUND' | 'REPOSITORY_ANALYSIS_FAILED' | 'REPOSITORY_ANALYZER_BUSY' | 'REPOSITORY_ANALYZER_UNAVAILABLE' | 'REPOSITORY_ANALYSIS_LIMIT_REACHED';

export class RepositoryAnalysisError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: RepositoryAnalysisErrorCode, readonly statusCode: number) {
    super(message);
    this.name = 'RepositoryAnalysisError';
  }
}

export interface RepositoryAnalysisRecord extends RepositoryArchiveReport {
  _id: unknown;
  ownerId: unknown;
  projectId?: unknown;
  name: string;
  status: 'completed';
  analyzerVersion: 1;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface RepositoryAnalysisRepository {
  create(value: Omit<RepositoryAnalysisRecord, '_id' | 'createdAt' | 'updatedAt'>): Promise<RepositoryAnalysisRecord>;
  list(ownerId: string, projectId: string | undefined, orphaned: boolean, page: number): Promise<{ records: RepositoryAnalysisRecord[]; total: number }>;
  findByOwnerAndId(ownerId: string, analysisId: string): Promise<RepositoryAnalysisRecord | null>;
  countByOwner(ownerId: string): Promise<number>;
  deleteByOwnerAndId(ownerId: string, analysisId: string): Promise<RepositoryAnalysisRecord | null>;
}

export const REPOSITORY_ANALYSIS_PAGE_SIZE = 50;
export const REPOSITORY_ANALYSIS_MAX_PAGES = 10;

export const mongooseRepositoryAnalysisRepository: RepositoryAnalysisRepository = {
  async create(value) {
    return RepositoryAnalysisModel.create(value) as unknown as Promise<RepositoryAnalysisRecord>;
  },
  async list(ownerId, projectId, orphaned, page) {
    const skip = (page - 1) * REPOSITORY_ANALYSIS_PAGE_SIZE;
    if (orphaned) {
      const result = await RepositoryAnalysisModel.aggregate([
        { $match: { ownerId: new mongoose.Types.ObjectId(ownerId), projectId: { $exists: true, $ne: null } } },
        { $lookup: { from: ProjectModel.collection.name, localField: 'projectId', foreignField: '_id', as: 'linkedProject' } },
        { $match: { 'linkedProject.0': { $exists: false } } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $facet: {
          metadata: [{ $count: 'total' }],
          records: [
            { $skip: skip },
            { $limit: REPOSITORY_ANALYSIS_PAGE_SIZE },
            { $project: { _id: 1, projectId: 1, name: 1, status: 1, analyzerVersion: 1, source: 1, summary: 1, createdAt: 1, updatedAt: 1 } },
          ],
        } },
      ]) as Array<{ records?: RepositoryAnalysisRecord[]; metadata?: Array<{ total?: number }> }>;
      return { records: result[0]?.records ?? [], total: result[0]?.metadata?.[0]?.total ?? 0 };
    }
    const filter = projectId
      ? { ownerId, projectId }
      : { ownerId, projectId: { $exists: false } };
    const [records, total] = await Promise.all([
      RepositoryAnalysisModel.find(filter)
      .select('_id projectId name status analyzerVersion source summary createdAt updatedAt')
      .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(REPOSITORY_ANALYSIS_PAGE_SIZE).lean() as unknown as Promise<RepositoryAnalysisRecord[]>,
      RepositoryAnalysisModel.countDocuments(filter),
    ]);
    return { records, total };
  },
  async findByOwnerAndId(ownerId, analysisId) {
    return RepositoryAnalysisModel.findOne({ _id: analysisId, ownerId }).lean() as unknown as Promise<RepositoryAnalysisRecord | null>;
  },
  async countByOwner(ownerId) { return RepositoryAnalysisModel.countDocuments({ ownerId }); },
  async deleteByOwnerAndId(ownerId, analysisId) {
    return RepositoryAnalysisModel.findOneAndDelete({ _id: analysisId, ownerId }).lean() as unknown as Promise<RepositoryAnalysisRecord | null>;
  },
};

export interface RepositoryUpload { buffer: Buffer; originalname: string; mimetype: string; size: number }
export interface RepositoryAnalysisCreateInput { name?: unknown; projectId?: unknown }
export interface RepositoryZipAnalyzer {
  (buffer: Buffer, originalName: string, mimeType: string): Promise<RepositoryArchiveReport>;
  isAvailable?: () => Promise<boolean>;
}
export const productionRepositoryZipAnalyzer: RepositoryZipAnalyzer = repositoryImporterAnalyzerFromEnvironment(process.env)
  ?? analyzeRepositoryZipIsolated;

const OBJECT_ID = /^[a-f\d]{24}$/i;

function requireOwnerId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new RepositoryAnalysisError('Owner id is invalid.', 'INVALID_REPOSITORY_INPUT', 400);
  return value;
}

function requireAnalysisId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new RepositoryAnalysisError('Analysis id is invalid.', 'INVALID_REPOSITORY_INPUT', 400);
  return value;
}

function requirePage(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new RepositoryAnalysisError('Repository history page is invalid.', 'INVALID_REPOSITORY_INPUT', 400);
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page > REPOSITORY_ANALYSIS_MAX_PAGES) {
    throw new RepositoryAnalysisError('Repository history page is invalid.', 'INVALID_REPOSITORY_INPUT', 400);
  }
  return page;
}

function safeName(value: unknown, fallback: string): string {
  const selected = value === undefined || value === '' ? fallback : value;
  if (typeof selected !== 'string') throw new RepositoryAnalysisError('Analysis name is invalid.', 'INVALID_REPOSITORY_INPUT', 400);
  const normalized = selected.normalize('NFC').trim();
  if (!normalized || normalized.length > 200 || [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0xfffd || /[\p{Cc}\p{Cf}]/u.test(character);
  })) throw new RepositoryAnalysisError('Analysis name must contain 1 to 200 safe characters.', 'INVALID_REPOSITORY_INPUT', 400);
  return normalized;
}

function safeOriginalName(value: string): string {
  const base = value.replace(/^.*[\\/]/, '').normalize('NFC');
  if (!base.toLowerCase().endsWith('.zip') || base.length > 255 || base.length < 5) {
    throw new RepositoryAnalysisError('A .zip repository archive is required.', 'INVALID_REPOSITORY_INPUT', 400);
  }
  return safeName(base, 'repository.zip');
}

export interface PublicRepositoryAnalysis {
  id: string; projectId?: string; name: string; status: 'completed'; analyzerVersion: 1;
  source: RepositoryArchiveReport['source']; summary: RepositoryArchiveReport['summary'];
  tree?: RepositoryArchiveReport['tree']; languages?: RepositoryArchiveReport['languages']; manifests?: RepositoryArchiveReport['manifests'];
  dependencies?: RepositoryArchiveReport['dependencies']; frameworks?: RepositoryArchiveReport['frameworks'];
  signals?: RepositoryArchiveReport['signals']; warnings?: RepositoryArchiveReport['warnings']; createdAt?: Date; updatedAt?: Date;
}

export interface PublicRepositoryAnalysisPage {
  analyses: PublicRepositoryAnalysis[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number; maxPages: number };
}

function publicAnalysis(record: RepositoryAnalysisRecord): PublicRepositoryAnalysis {
  const documentRecord = record as unknown as { toObject?: () => RepositoryAnalysisRecord };
  const value = typeof documentRecord.toObject === 'function' ? documentRecord.toObject() : record;
  return {
    id: String(value._id),
    ...(value.projectId ? { projectId: String(value.projectId) } : {}),
    name: value.name,
    status: value.status,
    analyzerVersion: value.analyzerVersion,
    source: value.source,
    summary: value.summary,
    tree: value.tree,
    languages: value.languages,
    manifests: value.manifests,
    dependencies: value.dependencies,
    frameworks: value.frameworks,
    signals: value.signals,
    warnings: value.warnings,
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

function publicAnalysisSummary(record: RepositoryAnalysisRecord): PublicRepositoryAnalysis {
  const detail = publicAnalysis(record);
  return {
    id: detail.id, ...(detail.projectId ? { projectId: detail.projectId } : {}), name: detail.name,
    status: detail.status, analyzerVersion: detail.analyzerVersion, source: detail.source, summary: detail.summary,
    ...(detail.createdAt ? { createdAt: detail.createdAt } : {}), ...(detail.updatedAt ? { updatedAt: detail.updatedAt } : {}),
  };
}

export class RepositoryAnalysisService {
  private activeAnalyses = 0;

  constructor(
    private readonly repository: RepositoryAnalysisRepository = mongooseRepositoryAnalysisRepository,
    private readonly projects: Pick<ProjectService, 'resolveActiveProject' | 'resolveOwnedProject'> = projectService,
    private readonly analyzer: RepositoryZipAnalyzer = productionRepositoryZipAnalyzer,
    private readonly databaseAvailable: () => boolean = () => mongoose.connection.readyState === 1,
    private readonly projectLease: Pick<ProjectMutationLease, 'run'> = projectMutationLease,
  ) {}

  async status(ownerIdValue: unknown, projectIdValue?: unknown): Promise<Record<string, unknown>> {
    const ownerId = requireOwnerId(ownerIdValue);
    const project = await this.projects.resolveOwnedProject(ownerId, projectIdValue);
    const databaseAvailable = this.databaseAvailable();
    let analyzerAvailable = true;
    if (this.analyzer.isAvailable) {
      try { analyzerAvailable = await this.analyzer.isAvailable(); } catch { analyzerAvailable = false; }
    }
    return {
      available: databaseAvailable,
      canAnalyze: databaseAvailable && analyzerAvailable && (!project || project.status === 'active'),
      scope: { type: project ? 'project' : 'workspace', ...(project ? { projectId: String(project._id), projectStatus: project.status } : {}) },
      capabilities: { zip: true, githubUrl: false, localPath: false, extraction: false, execution: false, network: false },
      dependencies: [
        { id: 'mongodb', status: databaseAvailable ? 'available' : 'unavailable', ...(!databaseAvailable ? { message: 'MongoDB is unavailable.' } : {}) },
        ...(this.analyzer.isAvailable ? [{ id: 'repository-importer', status: analyzerAvailable ? 'available' : 'unavailable',
          ...(!analyzerAvailable ? { message: 'Repository importer is unavailable.' } : {}) }] : []),
      ],
      limits: REPOSITORY_LIMITS,
    };
  }

  async create(ownerIdValue: unknown, input: RepositoryAnalysisCreateInput, upload?: RepositoryUpload): Promise<PublicRepositoryAnalysis> {
    const ownerId = requireOwnerId(ownerIdValue);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['name', 'projectId'].includes(key))) {
      throw new RepositoryAnalysisError('Repository analysis input contains unsupported fields.', 'INVALID_REPOSITORY_INPUT', 400);
    }
    if (!upload || !Buffer.isBuffer(upload.buffer)) throw new RepositoryAnalysisError('A repository ZIP archive is required.', 'INVALID_REPOSITORY_INPUT', 400);
    if (!['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(upload.mimetype)
      || upload.size !== upload.buffer.length || upload.buffer.length > REPOSITORY_LIMITS.archiveBytes) {
      throw new RepositoryAnalysisError('A valid ZIP upload is required.', 'INVALID_REPOSITORY_INPUT', 400);
    }
    const project = await this.projects.resolveActiveProject(ownerId, input.projectId);
    let ownerAnalysisCount: number;
    try { ownerAnalysisCount = await this.repository.countByOwner(ownerId); }
    catch { throw new RepositoryAnalysisError('Repository analysis storage is unavailable.', 'REPOSITORY_ANALYSIS_FAILED', 503); }
    if (ownerAnalysisCount >= 100) {
      throw new RepositoryAnalysisError('The saved repository analysis limit has been reached.', 'REPOSITORY_ANALYSIS_LIMIT_REACHED', 409);
    }
    const originalName = safeOriginalName(upload.originalname);
    const name = safeName(input.name, originalName.slice(0, -4));
    if (this.activeAnalyses >= 2) throw new RepositoryAnalysisError('The repository analyzer is busy. Try again shortly.', 'REPOSITORY_ANALYZER_BUSY', 429);
    this.activeAnalyses += 1;
    try {
      let report: RepositoryArchiveReport;
      try { report = await this.analyzer(upload.buffer, originalName, upload.mimetype); }
      catch (error) {
        if (error instanceof RepositoryArchiveError) throw error;
        if (error instanceof RepositoryImporterBusyError) {
          throw new RepositoryAnalysisError('The repository analyzer is busy. Try again shortly.', 'REPOSITORY_ANALYZER_BUSY', 429);
        }
        if (error instanceof RepositoryImporterUnavailableError) {
          throw new RepositoryAnalysisError('Repository importer is unavailable.', 'REPOSITORY_ANALYZER_UNAVAILABLE', 503);
        }
        throw new RepositoryAnalysisError('The repository ZIP could not be analyzed safely.', 'REPOSITORY_ANALYSIS_FAILED', 422);
      }
      const publish = async () => {
        if (project) await this.projects.resolveActiveProject(ownerId, String(project._id));
        return this.repository.create({
          ownerId, ...(project ? { projectId: String(project._id) } : {}), name, status: 'completed', analyzerVersion: 1, ...report,
        });
      };
      const record = project ? await this.projectLease.run(String(project._id), publish) : await publish();
      return publicAnalysis(record);
    } catch (error) {
      if (error instanceof RepositoryAnalysisError || error instanceof ProjectError) throw error;
      if (error instanceof RepositoryArchiveError) throw error;
      throw new RepositoryAnalysisError('The repository analysis could not be saved.', 'REPOSITORY_ANALYSIS_FAILED', 500);
    } finally {
      this.activeAnalyses -= 1;
    }
  }

  async list(ownerIdValue: unknown, projectIdValue?: unknown, scopeValue?: unknown, pageValue?: unknown): Promise<PublicRepositoryAnalysisPage> {
    const ownerId = requireOwnerId(ownerIdValue);
    const page = requirePage(pageValue);
    if ((scopeValue !== undefined && scopeValue !== 'orphaned') || (scopeValue === 'orphaned' && projectIdValue !== undefined)) {
      throw new RepositoryAnalysisError('Choose either a project or deleted-project history.', 'INVALID_REPOSITORY_INPUT', 400);
    }
    if (scopeValue === 'orphaned') {
      let result: { records: RepositoryAnalysisRecord[]; total: number };
      try {
        result = await this.repository.list(ownerId, undefined, true, page);
      }
      catch { throw new RepositoryAnalysisError('Repository analysis storage is unavailable.', 'REPOSITORY_ANALYSIS_FAILED', 503); }
      const totalPages = Math.max(1, Math.ceil(result.total / REPOSITORY_ANALYSIS_PAGE_SIZE));
      if (page > totalPages) throw new RepositoryAnalysisError('Repository history page does not exist.', 'INVALID_REPOSITORY_INPUT', 400);
      return {
        analyses: result.records.map(publicAnalysisSummary),
        pagination: { page, pageSize: REPOSITORY_ANALYSIS_PAGE_SIZE, total: result.total,
          totalPages, maxPages: REPOSITORY_ANALYSIS_MAX_PAGES },
      };
    }
    let projectId: string | undefined;
    try {
      const project = await this.projects.resolveOwnedProject(ownerId, projectIdValue);
      projectId = project ? String(project._id) : undefined;
    } catch (error) {
      if (!(error instanceof ProjectError) || error.code !== 'PROJECT_NOT_FOUND'
        || typeof projectIdValue !== 'string' || !OBJECT_ID.test(projectIdValue)) throw error;
      projectId = projectIdValue;
    }
    let result: { records: RepositoryAnalysisRecord[]; total: number };
    try { result = await this.repository.list(ownerId, projectId, false, page); }
    catch { throw new RepositoryAnalysisError('Repository analysis storage is unavailable.', 'REPOSITORY_ANALYSIS_FAILED', 503); }
    const totalPages = Math.max(1, Math.ceil(result.total / REPOSITORY_ANALYSIS_PAGE_SIZE));
    if (page > totalPages) throw new RepositoryAnalysisError('Repository history page does not exist.', 'INVALID_REPOSITORY_INPUT', 400);
    return {
      analyses: result.records.map(publicAnalysisSummary),
      pagination: { page, pageSize: REPOSITORY_ANALYSIS_PAGE_SIZE, total: result.total,
        totalPages, maxPages: REPOSITORY_ANALYSIS_MAX_PAGES },
    };
  }

  async get(ownerIdValue: unknown, analysisIdValue: unknown): Promise<PublicRepositoryAnalysis> {
    const ownerId = requireOwnerId(ownerIdValue);
    const analysisId = requireAnalysisId(analysisIdValue);
    let record: RepositoryAnalysisRecord | null;
    try { record = await this.repository.findByOwnerAndId(ownerId, analysisId); }
    catch { throw new RepositoryAnalysisError('Repository analysis storage is unavailable.', 'REPOSITORY_ANALYSIS_FAILED', 503); }
    if (!record) throw new RepositoryAnalysisError('Repository analysis not found.', 'REPOSITORY_ANALYSIS_NOT_FOUND', 404);
    return publicAnalysis(record);
  }

  async delete(ownerIdValue: unknown, analysisIdValue: unknown): Promise<void> {
    const ownerId = requireOwnerId(ownerIdValue);
    const analysisId = requireAnalysisId(analysisIdValue);
    let existing: RepositoryAnalysisRecord | null;
    try { existing = await this.repository.findByOwnerAndId(ownerId, analysisId); }
    catch { throw new RepositoryAnalysisError('Repository analysis storage is unavailable.', 'REPOSITORY_ANALYSIS_FAILED', 503); }
    if (!existing) throw new RepositoryAnalysisError('Repository analysis not found.', 'REPOSITORY_ANALYSIS_NOT_FOUND', 404);
    const remove = async (): Promise<RepositoryAnalysisRecord | null> => {
      if (existing.projectId) {
        try { await this.projects.resolveActiveProject(ownerId, String(existing.projectId)); }
        catch (error) {
          if (!(error instanceof ProjectError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
        }
      }
      return this.repository.deleteByOwnerAndId(ownerId, analysisId);
    };
    let deleted: RepositoryAnalysisRecord | null;
    try { deleted = existing.projectId ? await this.projectLease.run(String(existing.projectId), remove) : await remove(); }
    catch (error) {
      if (error instanceof ProjectError) throw error;
      throw new RepositoryAnalysisError('Repository analysis storage is unavailable.', 'REPOSITORY_ANALYSIS_FAILED', 503);
    }
    if (!deleted) throw new RepositoryAnalysisError('Repository analysis not found.', 'REPOSITORY_ANALYSIS_NOT_FOUND', 404);
  }
}

export const repositoryAnalysisService = new RepositoryAnalysisService();
