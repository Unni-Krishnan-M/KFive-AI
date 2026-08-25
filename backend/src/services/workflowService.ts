import { WorkflowDefinition, WorkflowModel, WORKFLOW_SCHEMA_VERSION, isExactWorkflowDefinition } from '@/models/Workflow';
import { WorkflowRunModel } from '@/models/WorkflowRun';
import { ProjectError, ProjectRecord, projectService } from './projectService';
import { releaseWorkflowExecutionLease, tryAcquireWorkflowExecutionLease } from './workflowExecutionLease';

export type WorkflowErrorCode =
  | 'INVALID_WORKFLOW_ID'
  | 'INVALID_WORKFLOW_INPUT'
  | 'INVALID_WORKFLOW_DEFINITION'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_PROJECT_IMMUTABLE'
  | 'WORKFLOW_HAS_ACTIVE_RUNS'
  | 'WORKFLOW_HAS_RUN_HISTORY'
  | 'WORKFLOW_LIMIT_REACHED'
  | 'WORKFLOW_STORAGE_UNAVAILABLE';

export class WorkflowError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: WorkflowErrorCode, readonly statusCode: number) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface WorkflowRecord {
  _id: unknown;
  ownerId: unknown;
  projectId?: unknown;
  name: string;
  description: string;
  schemaVersion: 1;
  revision: number;
  definition: WorkflowDefinition;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export interface PublicWorkflow {
  id: string;
  projectId?: string;
  name: string;
  description: string;
  schemaVersion: 1;
  revision: number;
  definition: WorkflowDefinition;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface WorkflowCreateData {
  ownerId: string;
  projectId?: unknown;
  name: string;
  description: string;
  schemaVersion: 1;
  revision: number;
  definition: WorkflowDefinition;
}

export interface WorkflowUpdateInput { name?: string; description?: string; definition?: WorkflowDefinition }

export interface WorkflowRepository {
  list(ownerId: string, projectId?: unknown): Promise<WorkflowRecord[]>;
  countByOwner(ownerId: string): Promise<number>;
  create(value: WorkflowCreateData): Promise<WorkflowRecord>;
  findByOwnerAndId(ownerId: string, workflowId: string): Promise<WorkflowRecord | null>;
  updateByOwnerAndId(ownerId: string, workflowId: string, changes: WorkflowUpdateInput): Promise<WorkflowRecord | null>;
  deleteByOwnerAndId(ownerId: string, workflowId: string): Promise<WorkflowRecord | null>;
  hasActiveRuns(ownerId: string, workflowId: string): Promise<boolean>;
  hasRuns(ownerId: string, workflowId: string): Promise<boolean>;
}

export const mongooseWorkflowRepository: WorkflowRepository = {
  async list(ownerId, projectId) {
    return WorkflowModel.find({ ownerId, ...(projectId ? { projectId } : {}) })
      .sort({ updatedAt: -1, _id: -1 }).limit(100).lean() as unknown as Promise<WorkflowRecord[]>;
  },
  async countByOwner(ownerId) { return WorkflowModel.countDocuments({ ownerId }); },
  async create(value) { return WorkflowModel.create(value) as unknown as Promise<WorkflowRecord>; },
  async findByOwnerAndId(ownerId, workflowId) {
    return WorkflowModel.findOne({ _id: workflowId, ownerId }) as unknown as Promise<WorkflowRecord | null>;
  },
  async updateByOwnerAndId(ownerId, workflowId, changes) {
    return WorkflowModel.findOneAndUpdate(
      { _id: workflowId, ownerId },
      { $set: changes, $inc: { revision: 1 } },
      { new: true, runValidators: true }
    ) as unknown as Promise<WorkflowRecord | null>;
  },
  async deleteByOwnerAndId(ownerId, workflowId) {
    return WorkflowModel.findOneAndDelete({ _id: workflowId, ownerId }) as unknown as Promise<WorkflowRecord | null>;
  },
  async hasActiveRuns(ownerId, workflowId) {
    return Boolean(await WorkflowRunModel.exists({ ownerId, workflowId, status: { $in: ['queued', 'running', 'cancel-requested'] } }));
  },
  async hasRuns(ownerId, workflowId) { return Boolean(await WorkflowRunModel.exists({ ownerId, workflowId })); },
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new WorkflowError(`${label} is invalid.`, 'INVALID_WORKFLOW_ID', 400);
  return value;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new WorkflowError(`${label} must be a JSON object.`, 'INVALID_WORKFLOW_INPUT', 400);
  }
  return value as Record<string, unknown>;
}

function normalizedString(value: unknown, label: string, minimum: number, maximumBytes: number): string {
  if (typeof value !== 'string') throw new WorkflowError(`${label} must be a string.`, 'INVALID_WORKFLOW_INPUT', 400);
  const result = value.normalize('NFC').trim();
  const unsafe = [...result].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
  });
  if (result.length < minimum || Buffer.byteLength(result, 'utf8') > maximumBytes || unsafe) {
    throw new WorkflowError(`${label} must contain ${minimum} to ${maximumBytes} safe UTF-8 bytes.`, 'INVALID_WORKFLOW_INPUT', 400);
  }
  return result;
}

export function normalizeWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!isExactWorkflowDefinition(value)) {
    throw new WorkflowError(
      'Workflow definition must be exactly Input -> Prompt -> LLM -> Output with the supported fixed nodes, positions, edges, and configs.',
      'INVALID_WORKFLOW_DEFINITION',
      400
    );
  }
  const prompt = value.nodes[1];
  const llm = value.nodes[2];
  if (prompt.type !== 'prompt' || llm.type !== 'llm') {
    throw new WorkflowError('Workflow definition is invalid.', 'INVALID_WORKFLOW_DEFINITION', 400);
  }
  return {
    nodes: [
      { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
      { id: 'prompt', type: 'prompt', label: 'Prompt', position: { x: 320, y: 0 }, config: {
        template: prompt.config.template.normalize('NFC'),
        systemPrompt: prompt.config.systemPrompt.normalize('NFC'),
      } },
      { id: 'llm', type: 'llm', label: 'LLM', position: { x: 640, y: 0 }, config: {
        model: llm.config.model.normalize('NFC').trim(), temperature: llm.config.temperature,
      } },
      { id: 'output', type: 'output', label: 'Output', position: { x: 960, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'input-to-prompt', source: 'input', target: 'prompt' },
      { id: 'prompt-to-llm', source: 'prompt', target: 'llm' },
      { id: 'llm-to-output', source: 'llm', target: 'output' },
    ],
  };
}

export function validateWorkflowCreateInput(value: unknown): Omit<WorkflowCreateData, 'ownerId' | 'projectId' | 'schemaVersion' | 'revision'> & { projectId?: string } {
  const input = plainObject(value, 'Workflow input');
  const allowed = new Set(['name', 'description', 'definition', 'projectId']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new WorkflowError('Workflow input contains unsupported fields.', 'INVALID_WORKFLOW_INPUT', 400);
  return {
    name: normalizedString(input.name, 'Workflow name', 1, 120),
    description: input.description === undefined ? '' : normalizedString(input.description, 'Workflow description', 0, 2000),
    definition: normalizeWorkflowDefinition(input.definition),
    ...(input.projectId !== undefined ? { projectId: requireObjectId(input.projectId, 'Project id') } : {}),
  };
}

export function validateWorkflowUpdateInput(value: unknown, currentProjectId?: unknown): WorkflowUpdateInput {
  const input = plainObject(value, 'Workflow update');
  const allowed = new Set(['name', 'description', 'definition', 'projectId']);
  if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new WorkflowError('Workflow update must contain at least one supported field.', 'INVALID_WORKFLOW_INPUT', 400);
  }
  if (input.projectId !== undefined) {
    const current = currentProjectId === undefined || currentProjectId === null ? undefined : String(currentProjectId);
    const requested = input.projectId === null || input.projectId === '' ? undefined : requireObjectId(input.projectId, 'Project id');
    if (current !== requested) throw new WorkflowError('A workflow cannot be moved to a different project.', 'WORKFLOW_PROJECT_IMMUTABLE', 409);
  }
  const changes: WorkflowUpdateInput = {
    ...(input.name !== undefined ? { name: normalizedString(input.name, 'Workflow name', 1, 120) } : {}),
    ...(input.description !== undefined ? { description: normalizedString(input.description, 'Workflow description', 0, 2000) } : {}),
    ...(input.definition !== undefined ? { definition: normalizeWorkflowDefinition(input.definition) } : {}),
  };
  if (!Object.keys(changes).length) throw new WorkflowError('Workflow update must contain an editable field.', 'INVALID_WORKFLOW_INPUT', 400);
  return changes;
}

export function serializeWorkflow(record: WorkflowRecord): PublicWorkflow {
  const document = record as unknown as { toObject?: () => WorkflowRecord };
  const value = typeof document.toObject === 'function' ? document.toObject() : record;
  return {
    id: String(value._id), ...(value.projectId ? { projectId: String(value.projectId) } : {}),
    name: value.name, description: value.description, schemaVersion: WORKFLOW_SCHEMA_VERSION,
    revision: value.revision, definition: normalizeWorkflowDefinition(value.definition),
    ...(value.createdAt ? { createdAt: value.createdAt } : {}), ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

export class WorkflowService {
  constructor(
    private readonly repository: WorkflowRepository = mongooseWorkflowRepository,
    private readonly resolveActiveProject: (ownerId: string, projectId: unknown) => Promise<ProjectRecord | undefined> =
      (ownerId, projectId) => projectService.resolveActiveProject(ownerId, projectId),
    private readonly resolveOwnedProject: (ownerId: string, projectId: unknown) => Promise<ProjectRecord | undefined> =
      (ownerId, projectId) => projectService.resolveOwnedProject(ownerId, projectId)
  ) {}

  async list(ownerIdValue: unknown, projectIdValue?: unknown): Promise<PublicWorkflow[]> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const project = await this.resolveOwnedProject(ownerId, projectIdValue);
    try { return (await this.repository.list(ownerId, project?._id)).map(serializeWorkflow); }
    catch { throw new WorkflowError('Workflow storage is unavailable.', 'WORKFLOW_STORAGE_UNAVAILABLE', 503); }
  }

  async create(ownerIdValue: unknown, value: unknown): Promise<PublicWorkflow> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const input = validateWorkflowCreateInput(value);
    const project = await this.resolveActiveProject(ownerId, input.projectId);
    let count: number;
    try { count = await this.repository.countByOwner(ownerId); }
    catch { throw new WorkflowError('Workflow storage is unavailable.', 'WORKFLOW_STORAGE_UNAVAILABLE', 503); }
    if (count >= 100) {
      throw new WorkflowError('The saved workflow limit has been reached.', 'WORKFLOW_LIMIT_REACHED', 409);
    }
    try {
      return serializeWorkflow(await this.repository.create({
        ownerId, ...(project ? { projectId: project._id } : {}), name: input.name,
        description: input.description, schemaVersion: WORKFLOW_SCHEMA_VERSION, revision: 1, definition: input.definition,
      }));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('Workflow storage is unavailable.', 'WORKFLOW_STORAGE_UNAVAILABLE', 503);
    }
  }

  async get(ownerIdValue: unknown, workflowIdValue: unknown): Promise<PublicWorkflow> {
    return serializeWorkflow(await this.getRecord(ownerIdValue, workflowIdValue));
  }

  async getRecord(ownerIdValue: unknown, workflowIdValue: unknown): Promise<WorkflowRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    let record: WorkflowRecord | null;
    try { record = await this.repository.findByOwnerAndId(ownerId, workflowId); }
    catch { throw new WorkflowError('Workflow storage is unavailable.', 'WORKFLOW_STORAGE_UNAVAILABLE', 503); }
    if (!record) throw new WorkflowError('Workflow not found.', 'WORKFLOW_NOT_FOUND', 404);
    return record;
  }

  async getActiveRecord(ownerIdValue: unknown, workflowIdValue: unknown): Promise<WorkflowRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const record = await this.getRecord(ownerId, workflowIdValue);
    await this.resolveActiveProject(ownerId, record.projectId === undefined ? undefined : String(record.projectId));
    normalizeWorkflowDefinition(record.definition);
    return record;
  }

  async getDeletableRecord(ownerIdValue: unknown, workflowIdValue: unknown): Promise<WorkflowRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const record = await this.getRecord(ownerId, workflowIdValue);
    try { await this.resolveActiveProject(ownerId, record.projectId === undefined ? undefined : String(record.projectId)); }
    catch (error) {
      if (!(error instanceof ProjectError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
    }
    return record;
  }

  async update(ownerIdValue: unknown, workflowIdValue: unknown, value: unknown): Promise<PublicWorkflow> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    const current = await this.getActiveRecord(ownerId, workflowId);
    const changes = validateWorkflowUpdateInput(value, current.projectId);
    let updated: WorkflowRecord | null;
    try { updated = await this.repository.updateByOwnerAndId(ownerId, workflowId, changes); }
    catch { throw new WorkflowError('Workflow storage is unavailable.', 'WORKFLOW_STORAGE_UNAVAILABLE', 503); }
    if (!updated) throw new WorkflowError('Workflow not found.', 'WORKFLOW_NOT_FOUND', 404);
    return serializeWorkflow(updated);
  }

  async delete(ownerIdValue: unknown, workflowIdValue: unknown): Promise<{ workflowId: string; deleted: true }> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    await this.getDeletableRecord(ownerId, workflowId);
    if (!tryAcquireWorkflowExecutionLease(ownerId, workflowId)) {
      throw new WorkflowError('Cancel the active workflow run before deleting this workflow.', 'WORKFLOW_HAS_ACTIVE_RUNS', 409);
    }
    try {
      if (await this.repository.hasActiveRuns(ownerId, workflowId)) {
        throw new WorkflowError('Cancel the active workflow run before deleting this workflow.', 'WORKFLOW_HAS_ACTIVE_RUNS', 409);
      }
      if (await this.repository.hasRuns(ownerId, workflowId)) {
        throw new WorkflowError('Workflows with run history cannot be deleted. Delete terminal runs first.', 'WORKFLOW_HAS_RUN_HISTORY', 409);
      }
      const deleted = await this.repository.deleteByOwnerAndId(ownerId, workflowId);
      if (!deleted) throw new WorkflowError('Workflow not found.', 'WORKFLOW_NOT_FOUND', 404);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('Workflow storage is unavailable.', 'WORKFLOW_STORAGE_UNAVAILABLE', 503);
    } finally { releaseWorkflowExecutionLease(ownerId, workflowId); }
    return { workflowId, deleted: true };
  }
}

export const workflowService = new WorkflowService();
