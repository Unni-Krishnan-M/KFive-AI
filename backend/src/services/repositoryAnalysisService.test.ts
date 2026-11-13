import {
  mongooseRepositoryAnalysisRepository,
  RepositoryAnalysisRecord,
  RepositoryAnalysisRepository,
  RepositoryAnalysisService,
  productionRepositoryZipAnalyzer,
} from './repositoryAnalysisService';
import { analyzeRepositoryZipIsolated } from './repositoryArchiveIsolation';
import { RepositoryArchiveReport } from './repositoryArchiveAnalyzer';
import { ProjectError } from './projectService';
import { RepositoryAnalysisModel } from '../models/RepositoryAnalysis';
import { ProjectMutationLease } from './projectMutationLease';
import { RepositoryImporterUnavailableError } from './repositoryImporterClient';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const projectId = '64b000000000000000000101';
const analysisId = '64b000000000000000000201';

const report: RepositoryArchiveReport = {
  source: { kind: 'zip', originalName: 'repo.zip', mimeType: 'application/zip', compressedBytes: 100, sha256: 'a'.repeat(64) },
  summary: { fileCount: 1, directoryCount: 0, declaredUncompressedBytes: 10, maxDepth: 1, packageManifestCount: 0, testFileCount: 0 },
  tree: [{ path: 'index.ts', type: 'file', declaredBytes: 10, language: 'TypeScript' }],
  languages: [{ name: 'TypeScript', files: 1, declaredBytes: 10 }], manifests: [], dependencies: [], frameworks: [], signals: [], warnings: [],
};
const record: RepositoryAnalysisRecord = {
  _id: analysisId, ownerId, projectId, name: 'Repo', status: 'completed', analyzerVersion: 1, ...report,
};

function fakeRepository(overrides: Partial<RepositoryAnalysisRepository> = {}): RepositoryAnalysisRepository {
  return {
    create: jest.fn().mockResolvedValue(record), list: jest.fn().mockResolvedValue({ records: [record], total: 1 }),
    findByOwnerAndId: jest.fn().mockResolvedValue(record), countByOwner: jest.fn().mockResolvedValue(0),
    deleteByOwnerAndId: jest.fn().mockResolvedValue(record), ...overrides,
  };
}

function fakeProjects(status: 'active' | 'archived' = 'active') {
  return {
    resolveActiveProject: jest.fn(async (_owner: string, value: unknown) => value ? { _id: projectId, status } : undefined),
    resolveOwnedProject: jest.fn(async (_owner: string, value: unknown) => value ? { _id: projectId, status } : undefined),
  };
}

const upload = { buffer: Buffer.from('zip'), originalname: 'repo.zip', mimetype: 'application/zip', size: 3 };

describe('RepositoryAnalysisService', () => {
  it('uses the isolated parser adapter for the production default', () => {
    expect(productionRepositoryZipAnalyzer).toBe(analyzeRepositoryZipIsolated);
  });
  it('creates an active-project report and explicitly removes owner/internal fields', async () => {
    const repository = fakeRepository();
    const projects = fakeProjects();
    const lease = { run: jest.fn(async (_projectId: string, action: () => Promise<unknown>) => action()) };
    const service = new RepositoryAnalysisService(repository, projects as any, jest.fn().mockResolvedValue(report), () => true, lease as any);
    const result = await service.create(ownerId, { name: 'Repo', projectId }, upload);
    expect(projects.resolveActiveProject).toHaveBeenCalledTimes(2);
    expect(projects.resolveActiveProject).toHaveBeenLastCalledWith(ownerId, projectId);
    expect(lease.run).toHaveBeenCalledWith(projectId, expect.any(Function));
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId, projectId, status: 'completed', analyzerVersion: 1 }));
    expect(result).toMatchObject({ id: analysisId, projectId, name: 'Repo', tree: report.tree });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('__v');
  });

  it('keeps workspace and project report histories disjoint and permits exact archived project reads', async () => {
    const repository = fakeRepository();
    const projects = fakeProjects('archived');
    const service = new RepositoryAnalysisService(repository, projects as any, jest.fn(), () => true);
    const globalList = await service.list(ownerId);
    await service.list(ownerId, projectId);
    expect(repository.list).toHaveBeenNthCalledWith(1, ownerId, undefined, false, 1);
    expect(repository.list).toHaveBeenNthCalledWith(2, ownerId, projectId, false, 1);
    expect(projects.resolveOwnedProject).toHaveBeenLastCalledWith(ownerId, projectId);
    expect(globalList.analyses[0]).not.toHaveProperty('tree');
    expect(globalList.analyses[0]).not.toHaveProperty('dependencies');
  });

  it('returns a bounded page contract and forwards the requested page to owner-scoped storage', async () => {
    const repository = fakeRepository({
      list: jest.fn().mockResolvedValue({ records: [record], total: 100 }),
    } as any);
    const service = new RepositoryAnalysisService(repository, fakeProjects() as any, jest.fn(), () => true);

    const result = await (service.list as any)(ownerId, undefined, undefined, '2');

    expect(repository.list).toHaveBeenCalledWith(ownerId, undefined, false, 2);
    expect(result).toMatchObject({
      analyses: [expect.objectContaining({ id: analysisId })],
      pagination: { page: 2, pageSize: 50, total: 100, totalPages: 2, maxPages: 10 },
    });
  });

  it.each(['0', '-1', '01', '1.5', '11', ['1']])('rejects invalid repository history page %p before storage', async (page) => {
    const repository = fakeRepository();
    const service = new RepositoryAnalysisService(repository, fakeProjects() as any, jest.fn(), () => true);

    await expect((service.list as any)(ownerId, undefined, undefined, page)).rejects.toMatchObject({
      code: 'INVALID_REPOSITORY_INPUT', statusCode: 400,
    });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('rejects a page beyond the last retained page without returning contradictory metadata', async () => {
    const repository = fakeRepository({
      list: jest.fn().mockResolvedValue({ records: [], total: 1 }),
    } as any);
    const service = new RepositoryAnalysisService(repository, fakeProjects() as any, jest.fn(), () => true);

    await expect((service.list as any)(ownerId, undefined, undefined, '2')).rejects.toMatchObject({
      code: 'INVALID_REPOSITORY_INPUT', statusCode: 400,
    });
  });

  it('uses an unscoped-only workspace storage filter and an exact project storage filter', async () => {
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    const select = jest.fn().mockReturnValue({ sort });
    const find = jest.spyOn(RepositoryAnalysisModel, 'find').mockReturnValue({ select } as any);
    const countDocuments = jest.spyOn(RepositoryAnalysisModel, 'countDocuments').mockResolvedValue(0);

    await mongooseRepositoryAnalysisRepository.list(ownerId, undefined, false, 1);
    expect(find).toHaveBeenLastCalledWith({ ownerId, projectId: { $exists: false } });
    expect(countDocuments).toHaveBeenLastCalledWith({ ownerId, projectId: { $exists: false } });
    await mongooseRepositoryAnalysisRepository.list(ownerId, projectId, false, 2);
    expect(find).toHaveBeenLastCalledWith({ ownerId, projectId });
    expect(countDocuments).toHaveBeenLastCalledWith({ ownerId, projectId });
    expect(skip).toHaveBeenLastCalledWith(50);
    expect(limit).toHaveBeenLastCalledWith(50);
    find.mockRestore();
    countDocuments.mockRestore();
  });

  it('keeps deleted-project reports owner-scoped, listable by scope id, and deletable', async () => {
    const missingProject = {
      resolveOwnedProject: jest.fn().mockRejectedValue(new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)),
      resolveActiveProject: jest.fn().mockRejectedValue(new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)),
    };
    const repository = fakeRepository();
    const service = new RepositoryAnalysisService(repository, missingProject as any, jest.fn(), () => true);

    await expect(service.list(ownerId, projectId)).resolves.toMatchObject({ analyses: [expect.objectContaining({ id: analysisId })] });
    expect(repository.list).toHaveBeenCalledWith(ownerId, projectId, false, 1);
    await expect(service.get(ownerId, analysisId)).resolves.toMatchObject({ id: analysisId, projectId });
    await expect(service.delete(ownerId, analysisId)).resolves.toBeUndefined();
    expect(repository.deleteByOwnerAndId).toHaveBeenCalledWith(ownerId, analysisId);
  });

  it('discovers deleted-project reports without requiring a remembered project id', async () => {
    const repository = fakeRepository();
    const projects = fakeProjects();
    const service = new RepositoryAnalysisService(repository, projects as any, jest.fn(), () => true);
    await expect(service.list(ownerId, undefined, 'orphaned')).resolves.toMatchObject({
      analyses: [expect.objectContaining({ id: analysisId, projectId })],
      pagination: { page: 1, total: 1 },
    });
    expect(repository.list).toHaveBeenCalledWith(ownerId, undefined, true, 1);
    expect(projects.resolveOwnedProject).not.toHaveBeenCalled();
  });

  it.each([
    [projectId, 'orphaned'], ['', 'orphaned'], [undefined, 'all'], [undefined, ['orphaned']],
  ])('rejects ambiguous or invalid recovery queries (%s, %s)', async (project, scope) => {
    const repository = fakeRepository();
    const service = new RepositoryAnalysisService(repository, fakeProjects() as any, jest.fn(), () => true);
    await expect(service.list(ownerId, project, scope)).rejects.toMatchObject({ code: 'INVALID_REPOSITORY_INPUT', statusCode: 400 });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('owner-scopes orphan discovery before joining projects and returns bounded summaries', async () => {
    const aggregate = jest.spyOn(RepositoryAnalysisModel, 'aggregate').mockResolvedValue([record]);
    try {
      aggregate.mockResolvedValue([{ records: [record], metadata: [{ total: 1 }] }]);
      await expect(mongooseRepositoryAnalysisRepository.list(ownerId, undefined, true, 1)).resolves.toEqual({ records: [record], total: 1 });
      const pipeline = aggregate.mock.calls[0][0] as any[];
      expect(String(pipeline[0].$match.ownerId)).toBe(ownerId);
      expect(pipeline[0].$match.projectId).toEqual({ $exists: true, $ne: null });
      expect(pipeline[1].$lookup).toMatchObject({ localField: 'projectId', foreignField: '_id' });
      expect(pipeline[2]).toEqual({ $match: { 'linkedProject.0': { $exists: false } } });
      expect(pipeline[3]).toEqual({ $sort: { createdAt: -1, _id: -1 } });
      expect(pipeline.at(-1).$facet.metadata).toEqual([{ $count: 'total' }]);
      expect(pipeline.at(-1).$facet.records).toContainEqual({ $skip: 0 });
      expect(pipeline.at(-1).$facet.records).toContainEqual({ $limit: 50 });
      const projection = pipeline.at(-1).$facet.records.at(-1).$project;
      expect(projection).not.toHaveProperty('ownerId');
      expect(projection).not.toHaveProperty('tree');
    } finally { aggregate.mockRestore(); }
  });

  it.each(['PROJECT_ARCHIVED', 'PROJECT_NOT_FOUND'] as const)('does not publish after %s during archive analysis', async (code) => {
    const repository = fakeRepository();
    const projects = fakeProjects();
    const lease = new ProjectMutationLease();
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let finish!: (value: RepositoryArchiveReport) => void;
    const analyzed = new Promise<RepositoryArchiveReport>((resolve) => { finish = resolve; });
    const analyzer = jest.fn(() => { start(); return analyzed; });
    const service = new RepositoryAnalysisService(repository, projects as any, analyzer, () => true, lease);
    const creating = service.create(ownerId, { projectId }, upload);
    await started;
    await lease.run(projectId, async () => {
      projects.resolveActiveProject.mockRejectedValue(new ProjectError('Project changed.', code, code === 'PROJECT_ARCHIVED' ? 409 : 404));
    });
    finish(report);
    await expect(creating).rejects.toMatchObject({ code });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('keeps missing/cross-owner analysis records indistinguishable', async () => {
    const repository = fakeRepository({ findByOwnerAndId: jest.fn().mockResolvedValue(null) });
    const service = new RepositoryAnalysisService(repository, fakeProjects() as any, jest.fn(), () => true);
    await expect(service.get(otherOwnerId, analysisId)).rejects.toMatchObject({ code: 'REPOSITORY_ANALYSIS_NOT_FOUND', statusCode: 404 });
    expect(repository.findByOwnerAndId).toHaveBeenCalledWith(otherOwnerId, analysisId);
  });

  it('deletes only owner-scoped analyses and rejects archived project mutation', async () => {
    const repository = fakeRepository();
    const activeProjects = fakeProjects();
    const lease = { run: jest.fn(async (_projectId: string, action: () => Promise<unknown>) => action()) };
    const service = new RepositoryAnalysisService(repository, activeProjects as any, jest.fn(), () => true, lease as any);
    await service.delete(ownerId, analysisId);
    expect(lease.run).toHaveBeenCalledWith(projectId, expect.any(Function));
    expect(activeProjects.resolveActiveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(repository.deleteByOwnerAndId).toHaveBeenCalledWith(ownerId, analysisId);

    const archivedProjects = fakeProjects('archived');
    archivedProjects.resolveActiveProject.mockRejectedValue(new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409));
    const archived = new RepositoryAnalysisService(fakeRepository(), archivedProjects as any, jest.fn(), () => true);
    await expect(archived.delete(ownerId, analysisId)).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
  });

  it('reports Mongo state and archived write availability exactly', async () => {
    const offline = new RepositoryAnalysisService(fakeRepository(), fakeProjects('archived') as any, jest.fn(), () => false);
    await expect(offline.status(ownerId, projectId)).resolves.toMatchObject({
      available: false, canAnalyze: false,
      scope: { type: 'project', projectId, projectStatus: 'archived' },
      dependencies: [{ id: 'mongodb', status: 'unavailable', message: 'MongoDB is unavailable.' }],
    });
  });

  it('reports importer availability independently and fails uploads closed with a safe 503', async () => {
    const analyzer = jest.fn().mockRejectedValue(new RepositoryImporterUnavailableError()) as any;
    analyzer.isAvailable = jest.fn().mockResolvedValue(false);
    const repository = fakeRepository();
    const service = new RepositoryAnalysisService(repository, fakeProjects() as any, analyzer, () => true);
    await expect(service.status(ownerId)).resolves.toMatchObject({
      available: true, canAnalyze: false,
      dependencies: [
        { id: 'mongodb', status: 'available' },
        { id: 'repository-importer', status: 'unavailable', message: 'Repository importer is unavailable.' },
      ],
    });
    await expect(service.create(ownerId, {}, upload)).rejects.toMatchObject({
      code: 'REPOSITORY_ANALYZER_UNAVAILABLE', statusCode: 503, message: 'Repository importer is unavailable.',
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('enforces the per-owner retention cap before analysis', async () => {
    const analyzer = jest.fn();
    const service = new RepositoryAnalysisService(fakeRepository({ countByOwner: jest.fn().mockResolvedValue(100) }), fakeProjects() as any, analyzer, () => true);
    await expect(service.create(ownerId, {}, upload)).rejects.toMatchObject({ code: 'REPOSITORY_ANALYSIS_LIMIT_REACHED', statusCode: 409 });
    expect(analyzer).not.toHaveBeenCalled();
  });

  it('rejects C1 controls in report names before analysis', async () => {
    const analyzer = jest.fn();
    const service = new RepositoryAnalysisService(fakeRepository(), fakeProjects() as any, analyzer, () => true);
    await expect(service.create(ownerId, { name: `unsafe\u0085name` }, upload)).rejects.toMatchObject({
      code: 'INVALID_REPOSITORY_INPUT',
    });
    expect(analyzer).not.toHaveBeenCalled();
  });

  it('rejects a third concurrent analysis and wraps unknown parser errors safely', async () => {
    let release!: () => void;
    const pending = new Promise<RepositoryArchiveReport>((resolve) => { release = () => resolve(report); });
    const analyzer = jest.fn().mockReturnValue(pending);
    const service = new RepositoryAnalysisService(fakeRepository(), fakeProjects() as any, analyzer, () => true);
    const first = service.create(ownerId, { name: 'one' }, upload);
    const second = service.create(ownerId, { name: 'two' }, upload);
    await Promise.resolve(); await Promise.resolve();
    await expect(service.create(ownerId, { name: 'three' }, upload)).rejects.toMatchObject({ code: 'REPOSITORY_ANALYZER_BUSY' });
    release(); await Promise.all([first, second]);

    const failed = new RepositoryAnalysisService(fakeRepository(), fakeProjects() as any, jest.fn().mockRejectedValue(new Error('raw parser secret')), () => true);
    await expect(failed.create(ownerId, {}, upload)).rejects.toMatchObject({
      code: 'REPOSITORY_ANALYSIS_FAILED', message: 'The repository ZIP could not be analyzed safely.',
    });
  });
});
