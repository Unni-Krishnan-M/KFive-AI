const leases = new Set<string>();

function key(ownerId: string, workflowId: string): string { return `${ownerId}:${workflowId}`; }

export function tryAcquireWorkflowExecutionLease(ownerId: string, workflowId: string): boolean {
  const lease = key(ownerId, workflowId);
  if (leases.has(lease)) return false;
  leases.add(lease);
  return true;
}

export function releaseWorkflowExecutionLease(ownerId: string, workflowId: string): void {
  leases.delete(key(ownerId, workflowId));
}

export function resetWorkflowExecutionLeasesForTests(): void { leases.clear(); }
