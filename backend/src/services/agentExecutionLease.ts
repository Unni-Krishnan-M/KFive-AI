const leases = new Set<string>();

function key(ownerId: string, agentId: string): string { return `${ownerId}:${agentId}`; }

export function tryAcquireAgentExecutionLease(ownerId: string, agentId: string): boolean {
  const lease = key(ownerId, agentId);
  if (leases.has(lease)) return false;
  leases.add(lease);
  return true;
}

export function releaseAgentExecutionLease(ownerId: string, agentId: string): void {
  leases.delete(key(ownerId, agentId));
}

export function resetAgentExecutionLeasesForTests(): void { leases.clear(); }
