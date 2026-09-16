export class ProjectMutationLease {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    // MongoDB accepts either hex case for the same ObjectId. API-supplied IDs
    // must share the lease used by canonical IDs read back from the database.
    const key = /^[a-f\d]{24}$/i.test(projectId) ? projectId.toLowerCase() : projectId;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

export const projectMutationLease = new ProjectMutationLease();
