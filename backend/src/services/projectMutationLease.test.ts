import { ProjectMutationLease } from './projectMutationLease';

describe('ProjectMutationLease', () => {
  it('serializes mutations for one project while allowing different projects to proceed', async () => {
    const lease = new ProjectMutationLease();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = lease.run('project-a', async () => { order.push('first:start'); await firstGate; order.push('first:end'); });
    const second = lease.run('project-a', async () => { order.push('second'); });
    await lease.run('project-b', async () => { order.push('other'); });
    expect(order).toEqual(['first:start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  it('releases the queue after a failed mutation', async () => {
    const lease = new ProjectMutationLease();
    await expect(lease.run('project', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(lease.run('project', async () => 'next')).resolves.toBe('next');
  });
});
