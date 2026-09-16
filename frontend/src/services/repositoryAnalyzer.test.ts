import { describe, expect, it } from 'vitest';
import { repositoryHistoryScope } from './repositoryAnalyzer';
import { canCreateRepositoryAnalysis, canDeleteRepositoryAnalysis, effectiveRepositoryProjectStatus, isRepositoryScopeRequestCurrent, normalizeRepositoryAnalyses, normalizeRepositoryAnalysis, normalizeRepositoryStatus, repositoryAnalysisScopeKey, validateRepositoryArchive, validateRepositoryZipSignature } from './repositoryAnalyzer';

const complete = {
  id: 'analysis-1', projectId: 'project-1', name: 'KFive', status: 'completed', analyzerVersion: 1,
  source: { kind: 'zip', originalName: 'kfive.zip', mimeType: 'application/zip', compressedBytes: 100, sha256: 'a'.repeat(64) },
  summary: { fileCount: 4, directoryCount: 2, declaredUncompressedBytes: 300, maxDepth: 3, packageManifestCount: 1, testFileCount: 1 },
  languages: [{ name: 'TypeScript', files: 2, declaredBytes: 200 }],
  frameworks: [{ name: 'React', dependency: 'react', manifestPath: 'package.json' }],
  manifests: [{ path: 'package.json', packageName: 'app', packageManager: 'npm', dependencyCount: 1, scriptNames: ['test'] }],
  dependencies: [{ manifestPath: 'package.json', name: 'react', version: '^18', kind: 'runtime' }],
  signals: [{ kind: 'tests', path: 'src/app.test.ts', severity: 'info' }],
  tree: [{ path: 'src/', type: 'directory' }, { path: 'src/app.ts', type: 'file', declaredBytes: 100, language: 'TypeScript' }],
  warnings: [{ code: 'LIMIT', message: 'Some evidence was limited.', path: 'package.json' }], createdAt: '2026-08-24T00:00:00Z',
};

describe('repository analyzer contract', () => {
  it('rejects unknown, repeated, and project-combined recovery scopes without falling back to workspace', () => {
    expect(repositoryHistoryScope('', false)).toBe('workspace');
    expect(repositoryHistoryScope('?projectId=one', true)).toBe('workspace');
    expect(repositoryHistoryScope('?scope=orphaned', false)).toBe('orphaned');
    for (const search of ['?scope=all', '?scope=', '?scope=orphaned&scope=orphaned']) {
      expect(repositoryHistoryScope(search, false)).toBe('invalid');
    }
    expect(repositoryHistoryScope('?scope=orphaned&projectId=one', true)).toBe('invalid');
    expect(repositoryHistoryScope('?scope=orphaned&projectId=', false)).toBe('invalid');
  });
  it('normalizes status without inventing availability', () => {
    expect(normalizeRepositoryStatus({ data: { canAnalyze: true, scope: { type: 'project', projectId: 'p1', projectStatus: 'active' }, dependencies: [{ id: 'mongodb', status: 'available' }], limits: { archiveBytes: 10485760 } } })).toEqual({
      available: undefined, canAnalyze: true, scope: { type: 'project', projectId: 'p1', projectStatus: 'active' }, dependencies: [{ id: 'mongodb', status: 'available', message: undefined }], limits: { maxArchiveBytes: 10485760 },
    });
  });

  it('normalizes the exact evidence report and list envelope', () => {
    const analysis = normalizeRepositoryAnalysis({ data: { analysis: complete } });
    expect(analysis).toMatchObject({ id: 'analysis-1', summary: { fileCount: 4, packageManifestCount: 1 }, languages: [{ name: 'TypeScript', files: 2, declaredBytes: 200 }], manifests: [{ path: 'package.json', dependencyCount: 1, scriptNames: ['test'] }], dependencies: [{ name: 'react', version: '^18', kind: 'runtime' }], warnings: [{ code: 'LIMIT' }] });
    const summary = { id: complete.id, projectId: complete.projectId, name: complete.name, status: complete.status, analyzerVersion: complete.analyzerVersion, source: complete.source, summary: complete.summary, createdAt: complete.createdAt };
    expect(normalizeRepositoryAnalyses({ data: { analyses: [summary, { id: 'bad' }] } })).toEqual([expect.objectContaining({ id: 'analysis-1', summary: expect.objectContaining({ fileCount: 4 }) })]);
    expect(normalizeRepositoryAnalysis(summary)).toBeUndefined();
  });

  it('rejects incomplete, invalid-digest, and overlong hostile records', () => {
    expect(normalizeRepositoryAnalysis({ data: { analysis: { id: 'one', name: 'Missing report' } } })).toBeUndefined();
    expect(normalizeRepositoryAnalysis({ ...complete, source: { ...complete.source, sha256: 'not-a-digest' } })).toBeUndefined();
    const hostile = { ...complete, tree: [{ path: 'x'.repeat(513), type: 'file' }], warnings: [{ code: 'X', message: 'x'.repeat(301) }] };
    expect(normalizeRepositoryAnalysis(hostile)).toMatchObject({ tree: [], warnings: [] });
    const unicodeControl = { ...complete, tree: [{ path: 'src/hidden\u0085name.ts', type: 'file' }], signals: [{ kind: 'tests', path: 'src/hidden\u009fname.test.ts' }] };
    expect(normalizeRepositoryAnalysis(unicodeControl)).toMatchObject({ tree: [], signals: [] });
  });

  it('validates archive metadata and project mutation gates', () => {
    expect(validateRepositoryArchive({ name: 'repo.zip', type: 'application/zip', size: 100 })).toBeUndefined();
    expect(validateRepositoryArchive({ name: 'repo.zip', type: 'application/octet-stream', size: 100 })).toBeUndefined();
    expect(validateRepositoryArchive({ name: 'repo.tar', type: 'application/x-tar', size: 100 })).toBe('Choose a ZIP archive.');
    expect(validateRepositoryArchive({ name: 'repo.zip', type: 'application/zip', size: 101 }, 100)).toContain('smaller');
    expect(canCreateRepositoryAnalysis('active', true, true)).toBe(true);
    expect(canCreateRepositoryAnalysis('archived', true, true)).toBe(false);
    expect(canCreateRepositoryAnalysis('active', false, true)).toBe(false);
    expect(canDeleteRepositoryAnalysis(undefined, true)).toBe(true);
    expect(canDeleteRepositoryAnalysis('active', true)).toBe(true);
    expect(canDeleteRepositoryAnalysis('archived', true)).toBe(false);
    expect(canDeleteRepositoryAnalysis('active', false)).toBe(false);
    expect(effectiveRepositoryProjectStatus('active', 'archived')).toBe('archived');
    expect(effectiveRepositoryProjectStatus('archived', 'active')).toBe('active');
    expect(effectiveRepositoryProjectStatus('active', undefined)).toBe('active');
  });

  it('checks ZIP magic bytes before upload', async () => {
    await expect(validateRepositoryZipSignature(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]))).resolves.toBeUndefined();
    await expect(validateRepositoryZipSignature(new Blob([new Uint8Array([0x4e, 0x4f, 0x50, 0x45])]))).resolves.toBe('The selected file does not have a valid ZIP signature.');
  });

  it('invalidates requests when the requested repository scope or request generation changes', () => {
    expect(repositoryAnalysisScopeKey(false)).toBe('workspace');
    expect(repositoryAnalysisScopeKey(false, undefined, true)).toBe('orphaned');
    expect(repositoryAnalysisScopeKey(true, 'project-1', true)).toBe('project:project-1');
    expect(isRepositoryScopeRequestCurrent('orphaned', 'workspace', 4, 4)).toBe(false);
    expect(repositoryAnalysisScopeKey(true)).toBe('project:pending');
    expect(repositoryAnalysisScopeKey(true, 'project-1')).toBe('project:project-1');
    expect(isRepositoryScopeRequestCurrent('project:project-1', 'project:project-1', 4, 4)).toBe(true);
    expect(isRepositoryScopeRequestCurrent('project:project-2', 'project:project-1', 4, 4)).toBe(false);
    expect(isRepositoryScopeRequestCurrent('project:project-1', 'project:project-1', 5, 4)).toBe(false);
  });
});
