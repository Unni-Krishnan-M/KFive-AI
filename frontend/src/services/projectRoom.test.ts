import { describe, expect, it } from 'vitest';
import { reconcileSelectedProject } from './projectRoom';

describe('Project Room selection reconciliation', () => {
  it('replaces a stale selection with the canonical refreshed project', () => {
    const stale = { _id: 'project-1', name: 'Before', activity: [] as string[] };
    const refreshed = { _id: 'project-1', name: 'After', activity: ['renamed'] };

    expect(reconcileSelectedProject(stale, [refreshed])).toBe(refreshed);
  });

  it('clears selection when the project is no longer in the active filter', () => {
    const selected = { _id: 'project-1', name: 'Archived' };
    expect(reconcileSelectedProject(selected, [])).toBeUndefined();
  });
});
