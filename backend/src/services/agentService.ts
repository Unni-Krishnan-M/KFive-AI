import { Agent } from '@/models/Agent';
import { AgentRunModel } from '@/models/AgentRun';
import { getEnvironment } from '@/config/environment';
import { ProjectError, ProjectRecord, projectService } from './projectService';
import { releaseAgentExecutionLease, tryAcquireAgentExecutionLease } from './agentExecutionLease';

export const AGENT_TOOL_ALLOWLIST = Object.freeze([] as string[]);

export type AgentErrorCode =
  | 'INVALID_AGENT_ID'
  | 'INVALID_AGENT_INPUT'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_PROJECT_IMMUTABLE'
  | 'AGENT_TOOL_UNAVAILABLE'
  | 'AGENT_HAS_ACTIVE_RUNS'
  | 'AGENT_HAS_RUN_HISTORY'
  | 'AGENT_STORAGE_UNAVAILABLE';

export class AgentError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: AgentErrorCode, readonly statusCode: number) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentRecord {
  _id: unknown;
  userId: unknown;
  projectId?: unknown;
  name: string;
  description: string;
  systemPrompt: string;
  aiModel: string;
  temperature: number;
  tools: string[];
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export interface PublicAgent {
  id: string;
  projectId?: string;
  name: string;
  description: string;
  systemPrompt: string;
  aiModel: string;
  temperature: number;
  tools: string[];
  toolState: 'disabled' | 'legacy-blocked';
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AgentUpdateInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  aiModel?: string;
  temperature?: number;
  tools?: string[];
}

export interface AgentCreateData extends Required<AgentUpdateInput> {
  userId: string;
  projectId?: unknown;
}

export interface AgentRepository {
  list(ownerId: string, projectId?: unknown): Promise<AgentRecord[]>;
  create(value: AgentCreateData): Promise<AgentRecord>;
  findByOwnerAndId(ownerId: string, agentId: string): Promise<AgentRecord | null>;
  updateByOwnerAndId(ownerId: string, agentId: string, changes: AgentUpdateInput): Promise<AgentRecord | null>;
  deleteByOwnerAndId(ownerId: string, agentId: string): Promise<AgentRecord | null>;
  hasActiveRuns(ownerId: string, agentId: string): Promise<boolean>;
  hasRuns(ownerId: string, agentId: string): Promise<boolean>;
}

export const mongooseAgentRepository: AgentRepository = {
  async list(ownerId, projectId) {
    return Agent.find({ userId: ownerId, ...(projectId ? { projectId } : {}) })
      .sort({ updatedAt: -1, _id: -1 }).limit(100).lean() as unknown as Promise<AgentRecord[]>;
  },
  async create(value) { return Agent.create(value) as unknown as Promise<AgentRecord>; },
  async findByOwnerAndId(ownerId, agentId) {
    return Agent.findOne({ _id: agentId, userId: ownerId }) as unknown as Promise<AgentRecord | null>;
  },
  async updateByOwnerAndId(ownerId, agentId, changes) {
    return Agent.findOneAndUpdate({ _id: agentId, userId: ownerId }, { $set: changes }, { new: true, runValidators: true }) as unknown as Promise<AgentRecord | null>;
  },
  async deleteByOwnerAndId(ownerId, agentId) {
    return Agent.findOneAndDelete({ _id: agentId, userId: ownerId }) as unknown as Promise<AgentRecord | null>;
  },
  async hasActiveRuns(ownerId, agentId) {
    return Boolean(await AgentRunModel.exists({ ownerId, agentId, status: { $in: ['queued', 'running', 'cancel-requested'] } }));
  },
  async hasRuns(ownerId, agentId) { return Boolean(await AgentRunModel.exists({ ownerId, agentId })); },
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new AgentError(`${label} is invalid.`, 'INVALID_AGENT_ID', 400);
  return value;
}

function hasUnsafeControls(value: string, allowNewlines: boolean): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && !(allowNewlines && (point === 9 || point === 10))) || (point >= 127 && point <= 159);
  });
}

function normalizedString(value: unknown, label: string, min: number, max: number, allowNewlines = false): string {
  if (typeof value !== 'string') throw new AgentError(`${label} must be a string.`, 'INVALID_AGENT_INPUT', 400);
  const result = value.normalize('NFC').trim();
  if (result.length < min || result.length > max || Buffer.byteLength(result, 'utf8') > max || hasUnsafeControls(result, allowNewlines)) {
    throw new AgentError(`${label} must contain ${min} to ${max} safe UTF-8 bytes.`, 'INVALID_AGENT_INPUT', 400);
  }
  return result;
}

function normalizedTools(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AgentError('Agent tools must be an array.', 'INVALID_AGENT_INPUT', 400);
  if (value.length !== 0) {
    throw new AgentError('Agent tools are not enabled in this release.', 'AGENT_TOOL_UNAVAILABLE', 400);
  }
  return [];
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError(`${label} must be a JSON object.`, 'INVALID_AGENT_INPUT', 400);
  return value as Record<string, unknown>;
}

function temperature(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new AgentError('Agent temperature must be a number from 0 to 2.', 'INVALID_AGENT_INPUT', 400);
  }
  return value;
}

export function validateAgentCreateInput(value: unknown, defaultModel: string): Omit<AgentCreateData, 'userId' | 'projectId'> & { projectId?: string } {
  const input = plainObject(value, 'Agent input');
  const allowed = new Set(['name', 'description', 'systemPrompt', 'aiModel', 'temperature', 'tools', 'projectId']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new AgentError('Agent input contains unsupported fields.', 'INVALID_AGENT_INPUT', 400);
  return {
    name: normalizedString(input.name, 'Agent name', 1, 100),
    description: input.description === undefined ? 'A helpful AI Agent' : normalizedString(input.description, 'Agent description', 0, 1000, true),
    systemPrompt: normalizedString(input.systemPrompt, 'System prompt', 1, 20_000, true),
    aiModel: input.aiModel === undefined ? normalizedString(defaultModel, 'AI model', 1, 200) : normalizedString(input.aiModel, 'AI model', 1, 200),
    temperature: temperature(input.temperature, 0.7),
    tools: input.tools === undefined ? [] : normalizedTools(input.tools),
    ...(input.projectId !== undefined ? { projectId: requireObjectId(input.projectId, 'Project id') } : {}),
  };
}

export function validateAgentUpdateInput(value: unknown, currentProjectId?: unknown): AgentUpdateInput {
  const input = plainObject(value, 'Agent update');
  const allowed = new Set(['name', 'description', 'systemPrompt', 'aiModel', 'temperature', 'tools', 'projectId']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new AgentError('Agent update contains unsupported fields.', 'INVALID_AGENT_INPUT', 400);
  if (input.projectId !== undefined) {
    const current = currentProjectId === undefined || currentProjectId === null ? undefined : String(currentProjectId);
    const requested = input.projectId === null || input.projectId === '' ? undefined : requireObjectId(input.projectId, 'Project id');
    if (requested !== current) throw new AgentError('An agent cannot be moved to a different project.', 'AGENT_PROJECT_IMMUTABLE', 409);
  }
  const changes: AgentUpdateInput = {
    ...(input.name !== undefined ? { name: normalizedString(input.name, 'Agent name', 1, 100) } : {}),
    ...(input.description !== undefined ? { description: normalizedString(input.description, 'Agent description', 0, 1000, true) } : {}),
    ...(input.systemPrompt !== undefined ? { systemPrompt: normalizedString(input.systemPrompt, 'System prompt', 1, 20_000, true) } : {}),
    ...(input.aiModel !== undefined ? { aiModel: normalizedString(input.aiModel, 'AI model', 1, 200) } : {}),
    ...(input.temperature !== undefined ? { temperature: temperature(input.temperature) } : {}),
    ...(input.tools !== undefined ? { tools: normalizedTools(input.tools) } : {}),
  };
  if (!Object.keys(changes).length) throw new AgentError('Agent update must contain at least one editable field.', 'INVALID_AGENT_INPUT', 400);
  return changes;
}

export function serializeAgent(record: AgentRecord): PublicAgent {
  const document = record as unknown as { toObject?: () => AgentRecord };
  const value = typeof document.toObject === 'function' ? document.toObject() : record;
  return {
    id: String(value._id), ...(value.projectId ? { projectId: String(value.projectId) } : {}),
    name: value.name, description: value.description, systemPrompt: value.systemPrompt,
    aiModel: value.aiModel, temperature: value.temperature, tools: [],
    toolState: !Array.isArray(value.tools) || value.tools.length === 0 ? 'disabled' : 'legacy-blocked',
    ...(value.createdAt ? { createdAt: value.createdAt } : {}), ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

export type ActiveProjectResolver = (ownerId: string, projectId: unknown) => Promise<ProjectRecord | undefined>;
export type OwnedProjectResolver = (ownerId: string, projectId: unknown) => Promise<ProjectRecord | undefined>;

export class AgentService {
  constructor(
    private readonly repository: AgentRepository = mongooseAgentRepository,
    private readonly resolveActiveProject: ActiveProjectResolver = (ownerId, projectId) => projectService.resolveActiveProject(ownerId, projectId),
    private readonly resolveOwnedProject: OwnedProjectResolver = (ownerId, projectId) => projectService.resolveOwnedProject(ownerId, projectId),
    private readonly defaultModel: () => string = () => getEnvironment().aiDefaultModel
  ) {}

  async list(ownerIdValue: unknown, projectIdValue?: unknown): Promise<PublicAgent[]> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const project = await this.resolveOwnedProject(ownerId, projectIdValue);
    try { return (await this.repository.list(ownerId, project?._id)).map(serializeAgent); }
    catch { throw new AgentError('Agent storage is unavailable.', 'AGENT_STORAGE_UNAVAILABLE', 503); }
  }

  async create(ownerIdValue: unknown, value: unknown): Promise<PublicAgent> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const input = validateAgentCreateInput(value, this.defaultModel());
    const project = await this.resolveActiveProject(ownerId, input.projectId);
    try {
      return serializeAgent(await this.repository.create({
        userId: ownerId, ...(project ? { projectId: project._id } : {}),
        name: input.name, description: input.description, systemPrompt: input.systemPrompt,
        aiModel: input.aiModel, temperature: input.temperature, tools: [],
      }));
    } catch { throw new AgentError('Agent storage is unavailable.', 'AGENT_STORAGE_UNAVAILABLE', 503); }
  }

  async get(ownerIdValue: unknown, agentIdValue: unknown): Promise<PublicAgent> {
    return serializeAgent(await this.getRecord(ownerIdValue, agentIdValue));
  }

  async getRecord(ownerIdValue: unknown, agentIdValue: unknown): Promise<AgentRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    let record: AgentRecord | null;
    try { record = await this.repository.findByOwnerAndId(ownerId, agentId); }
    catch { throw new AgentError('Agent storage is unavailable.', 'AGENT_STORAGE_UNAVAILABLE', 503); }
    if (!record) throw new AgentError('Agent not found.', 'AGENT_NOT_FOUND', 404);
    return record;
  }

  async getActiveRecord(ownerIdValue: unknown, agentIdValue: unknown): Promise<AgentRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const record = await this.getRecord(ownerId, agentIdValue);
    await this.resolveActiveProject(ownerId, record.projectId === undefined ? undefined : String(record.projectId));
    return record;
  }

  async getDeletableRecord(ownerIdValue: unknown, agentIdValue: unknown): Promise<AgentRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const record = await this.getRecord(ownerId, agentIdValue);
    try {
      await this.resolveActiveProject(ownerId, record.projectId === undefined ? undefined : String(record.projectId));
    } catch (error) {
      // Project deletion is intentionally non-cascading. Owners must still be
      // able to remove orphaned history, while archived projects stay read-only.
      if (!(error instanceof ProjectError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
    }
    return record;
  }

  async getExecutableRecord(ownerIdValue: unknown, agentIdValue: unknown): Promise<AgentRecord> {
    const record = await this.getActiveRecord(ownerIdValue, agentIdValue);
    if (record.tools.length !== 0) throw new AgentError('This agent contains tools that are not enabled.', 'AGENT_TOOL_UNAVAILABLE', 409);
    return record;
  }

  async update(ownerIdValue: unknown, agentIdValue: unknown, value: unknown): Promise<PublicAgent> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    const current = await this.getActiveRecord(ownerId, agentId);
    const changes = validateAgentUpdateInput(value, current.projectId);
    let updated: AgentRecord | null;
    try { updated = await this.repository.updateByOwnerAndId(ownerId, agentId, changes); }
    catch { throw new AgentError('Agent storage is unavailable.', 'AGENT_STORAGE_UNAVAILABLE', 503); }
    if (!updated) throw new AgentError('Agent not found.', 'AGENT_NOT_FOUND', 404);
    return serializeAgent(updated);
  }

  async delete(ownerIdValue: unknown, agentIdValue: unknown): Promise<{ agentId: string; deleted: true }> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    await this.getDeletableRecord(ownerId, agentId);
    if (!tryAcquireAgentExecutionLease(ownerId, agentId)) {
      throw new AgentError('Cancel the active agent run before deleting this agent.', 'AGENT_HAS_ACTIVE_RUNS', 409);
    }
    try {
      if (await this.repository.hasActiveRuns(ownerId, agentId)) throw new AgentError('Cancel the active agent run before deleting this agent.', 'AGENT_HAS_ACTIVE_RUNS', 409);
      if (await this.repository.hasRuns(ownerId, agentId)) {
        throw new AgentError('Agents with run history cannot be deleted because their audit timeline must remain accessible.', 'AGENT_HAS_RUN_HISTORY', 409);
      }
      const deleted = await this.repository.deleteByOwnerAndId(ownerId, agentId);
      if (!deleted) throw new AgentError('Agent not found.', 'AGENT_NOT_FOUND', 404);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('Agent storage is unavailable.', 'AGENT_STORAGE_UNAVAILABLE', 503);
    } finally {
      releaseAgentExecutionLease(ownerId, agentId);
    }
    return { agentId, deleted: true };
  }
}

export const agentService = new AgentService();
