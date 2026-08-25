import { describe, expect, it } from 'vitest';
import { normalizeCanonicalProject, projectContextPath, projectNavigationState, readProjectContext } from './projectContext';

describe('project navigation context', () => {
  it('reads validated navigation state and preserves unrelated state', () => {
    const context = readProjectContext({ projectId: '507f1f77bcf86cd799439011', projectName: 'RAG Research' });
    expect(context).toEqual({ projectId: '507f1f77bcf86cd799439011', projectName: 'RAG Research' });
    expect(projectNavigationState(context!, { documentId: 'doc-1' })).toEqual({
      documentId: 'doc-1', projectId: '507f1f77bcf86cd799439011', projectName: 'RAG Research',
    });
  });

  it('falls back to query context for refreshed and direct links', () => {
    const context = readProjectContext(undefined, '?projectId=507f1f77bcf86cd799439011&projectName=Code+Review');
    expect(context).toEqual({ projectId: '507f1f77bcf86cd799439011', projectName: 'Code Review' });
    expect(projectContextPath('/app/chat', context!)).toBe('/app/chat?projectId=507f1f77bcf86cd799439011&projectName=Code+Review');
  });

  it('rejects malformed project identifiers and handles ordinary direct visits', () => {
    expect(readProjectContext(undefined, '')).toBeUndefined();
    expect(readProjectContext({ projectId: '../../etc/passwd', projectName: 'Invalid' })).toBeUndefined();
    expect(readProjectContext({ projectId: 'project_7', projectName: 'Not a Mongo id' })).toBeUndefined();
  });

  it('uses canonical server name and status for the expected project only', () => {
    expect(normalizeCanonicalProject({ data: { project: {
      _id: '507f1f77bcf86cd799439011', name: 'Renamed project', status: 'archived',
    } } }, '507f1f77bcf86cd799439011')).toEqual({
      projectId: '507f1f77bcf86cd799439011', projectName: 'Renamed project', status: 'archived',
    });
    expect(normalizeCanonicalProject({ data: { project: {
      _id: '507f1f77bcf86cd799439012', name: 'Wrong project', status: 'active',
    } } }, '507f1f77bcf86cd799439011')).toBeUndefined();
  });
});
