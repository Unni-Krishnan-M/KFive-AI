export class ProjectMutationLease {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(projectId, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(projectId) === current) this.tails.delete(projectId);
    }
  }
}

export const projectMutationLease = new ProjectMutationLease();
