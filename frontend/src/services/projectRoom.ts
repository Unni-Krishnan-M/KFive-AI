export interface ProjectIdentity {
  _id: string;
}

export function reconcileSelectedProject<T extends ProjectIdentity>(
  selected: T | undefined,
  projects: readonly T[]
): T | undefined {
  if (!selected) return undefined;
  return projects.find((project) => project._id === selected._id);
}
