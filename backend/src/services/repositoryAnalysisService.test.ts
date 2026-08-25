import {
  mongooseRepositoryAnalysisRepository,
  RepositoryAnalysisRecord,
  RepositoryAnalysisRepository,
  RepositoryAnalysisService,
} from './repositoryAnalysisService';
import { RepositoryArchiveReport } from './repositoryArchiveAnalyzer';
import { ProjectError } from './projectService';
import { RepositoryAnalysisModel } from '../models/RepositoryAnalysis';

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
    create: jest.fn().mockResolvedValue(record), list: jest.fn().mockResolvedValue([record]),
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
  it('creates an active-project report and explicitly removes owner/internal fields', async () => {
    const repository = fakeRepository();
    const projects = fakeProjects();
    const service = new RepositoryAnalysisService(repository, projects as any, jest.fn().mockResolvedValue(report), () => true);
    const result = await service.create(ownerId, { name: 'Repo', projectId }, upload);
    expect(projects.resolveActiveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId, projectId, status: 'completed', analyzerVersion: 1 }));
    expect(result).toMatchObject({ id: analysisId, projectId, name: 'Repo', tree: report.tree });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('__v');
  });

  it('lists all owner reports in workspace scope and permits exact archived project reads', async () => {
    const repository = fakeRepository();
    const projects = fakeProjects('archived');
    const service = new RepositoryAnalysisService(repository, projects as any, jest.fn(), () => true);
    const globalList = await service.list(ownerId);
    await service.list(ownerId, projectId);
    expect(repository.list).toHaveBeenNthCalledWith(1, ownerId, undefined);
    expect(repository.list).toHaveBeenNthCalledWith(2, ownerId, projectId);
    expect(projects.resolveOwnedProject).toHaveBeenLastCalledWith(ownerId, projectId);
    expect(globalList[0]).toMatchObject({ projectId });
    expect(globalList[0]).not.toHaveProperty('tree');
    expect(globalList[0]).not.toHaveProperty('dependencies');
  });

  it('uses owner-only workspace storage filters and exact project storage filters', async () => {
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ limit });
    const select = jest.fn().mockReturnValue({ sort });
    const find = jest.spyOn(RepositoryAnalysisModel, 'find').mockReturnValue({ select } as any);

    await mongooseRepositoryAnalysisRepository.list(ownerId);
    expect(find).toHaveBeenLastCalledWith({ ownerId });
    await mongooseRepositoryAnalysisRepository.list(ownerId, projectId);
    expect(find).toHaveBeenLastCalledWith({ ownerId, projectId });
    find.mockRestore();
  });

  it('keeps deleted-project reports owner-scoped, listable by scope id, and deletable', async () => {
    const missingProject = {
      resolveOwnedProject: jest.fn().mockRejectedValue(new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)),
      resolveActiveProject: jest.fn().mockRejectedValue(new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)),
    };
    const repository = fakeRepository();
    const service = new RepositoryAnalysisService(repository, missingProject as any, jest.fn(), () => true);

    await expect(service.list(ownerId, projectId)).resolves.toHaveLength(1);
    expect(repository.list).toHaveBeenCalledWith(ownerId, projectId);
    await expect(service.get(ownerId, analysisId)).resolves.toMatchObject({ id: analysisId, projectId });
    await expect(service.delete(ownerId, analysisId)).resolves.toBeUndefined();
    expect(repository.deleteByOwnerAndId).toHaveBeenCalledWith(ownerId, analysisId);
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
    const service = new RepositoryAnalysisService(repository, activeProjects as any, jest.fn(), () => true);
    await service.delete(ownerId, analysisId);
    expect(activeProjects.resolveActiveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(repository.deleteByOwnerAndId).toHaveBeenCalledWith(ownerId, analysisId);

    const archivedProjects = fakeProjects('archived');
    archivedProjects.resolveActiveProject.mockRejectedValue(Object.assign(new Error('Project is archived.'), {
      code: 'PROJECT_ARCHIVED', statusCode: 409, isOperational: true,
    }));
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
