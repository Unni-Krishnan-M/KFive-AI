import { createHash, randomBytes } from 'crypto';
import { ProjectModel, ProjectActivityType, ProjectStatus } from '@/models/Project';
import { projectMutationLease } from './projectMutationLease';

export type ProjectErrorCode =
  | 'INVALID_PROJECT_ID'
  | 'INVALID_PROJECT_INPUT'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ARCHIVED'
  | 'INVALID_PROJECT_DELETE_CONFIRMATION'
  | 'EXPIRED_PROJECT_DELETE_CONFIRMATION';

export class ProjectError extends Error {
  readonly isOperational = true;

  constructor(
    message: string,
    readonly code: ProjectErrorCode,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export interface ProjectCreateData {
  ownerId: string;
  name: string;
  description: string;
  tags: string[];
  status: 'active';
  activity: ProjectActivityInput[];
  lastActivityAt: Date;
}

export interface ProjectActivityInput {
  type: ProjectActivityType;
  timestamp: Date;
  actorId: string;
  changes?: Record<string, unknown>;
}

export interface ProjectRecord {
  _id: unknown;
  ownerId: unknown;
  name: string;
  description: string;
  tags: string[];
  status: ProjectStatus;
  [key: string]: unknown;
}

export interface ProjectRepository {
  list(ownerId: string, status?: ProjectStatus): Promise<ProjectRecord[]>;
  create(data: ProjectCreateData): Promise<ProjectRecord>;
  findByOwnerAndId(ownerId: string, projectId: string): Promise<ProjectRecord | null>;
  updateByOwnerAndId(
    ownerId: string,
    projectId: string,
    changes: Partial<Pick<ProjectRecord, 'name' | 'description' | 'tags' | 'status'>>,
    events: ProjectActivityInput[],
    lastActivityAt: Date
  ): Promise<ProjectRecord | null>;
  deleteByOwnerAndId(ownerId: string, projectId: string): Promise<ProjectRecord | null>;
}

export const mongooseProjectRepository: ProjectRepository = {
  async list(ownerId, status) {
    return ProjectModel.find({ ownerId, ...(status ? { status } : {}) })
      .sort({ lastActivityAt: -1, _id: -1 })
      .lean() as unknown as Promise<ProjectRecord[]>;
  },
  async create(data) {
    return ProjectModel.create(data) as unknown as Promise<ProjectRecord>;
  },
  async findByOwnerAndId(ownerId, projectId) {
    return ProjectModel.findOne({ _id: projectId, ownerId }) as unknown as Promise<ProjectRecord | null>;
  },
  async updateByOwnerAndId(ownerId, projectId, changes, events, lastActivityAt) {
    return ProjectModel.findOneAndUpdate(
      { _id: projectId, ownerId },
      {
        $set: { ...changes, lastActivityAt },
        $push: { activity: { $each: events, $slice: -100 } },
      },
      { new: true, runValidators: true }
    ) as unknown as Promise<ProjectRecord | null>;
  },
  async deleteByOwnerAndId(ownerId, projectId) {
    return ProjectModel.findOneAndDelete({ _id: projectId, ownerId }) as unknown as Promise<ProjectRecord | null>;
  },
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw new ProjectError(`${label} is invalid.`, 'INVALID_PROJECT_ID', 400);
  }
  return value;
}

function requirePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectError('Project input must be a JSON object.', 'INVALID_PROJECT_INPUT', 400);
  }
  return value as Record<string, unknown>;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProjectError('Project name is required.', 'INVALID_PROJECT_INPUT', 400);
  }
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new ProjectError('Project name must contain 1 to 120 characters.', 'INVALID_PROJECT_INPUT', 400);
  }
  return name;
}

function normalizeDescription(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > 2000) {
    throw new ProjectError('Project description must contain at most 2000 characters.', 'INVALID_PROJECT_INPUT', 400);
  }
  return value.trim();
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new ProjectError('Project tags must be an array containing at most 20 values.', 'INVALID_PROJECT_INPUT', 400);
  }
  const tags = value.map((tag) => {
    if (typeof tag !== 'string') {
      throw new ProjectError('Every project tag must be a string.', 'INVALID_PROJECT_INPUT', 400);
    }
    const normalized = tag.trim();
    if (!normalized || normalized.length > 40) {
      throw new ProjectError('Every project tag must contain 1 to 40 characters.', 'INVALID_PROJECT_INPUT', 400);
    }
    return normalized;
  });
  if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length) {
    throw new ProjectError('Project tags must be unique.', 'INVALID_PROJECT_INPUT', 400);
  }
  return tags;
}

function normalizeStatus(value: unknown): ProjectStatus {
  if (value !== 'active' && value !== 'archived') {
    throw new ProjectError("Project status must be 'active' or 'archived'.", 'INVALID_PROJECT_INPUT', 400);
  }
  return value;
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string;
  tags?: string[];
  status?: ProjectStatus;
}

export function validateProjectCreateInput(value: unknown): Omit<ProjectCreateData, 'ownerId' | 'status' | 'activity' | 'lastActivityAt'> {
  const input = requirePlainObject(value);
  const allowed = new Set(['name', 'description', 'tags']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ProjectError('Project input contains unsupported fields.', 'INVALID_PROJECT_INPUT', 400);
  }
  return {
    name: normalizeName(input.name),
    description: normalizeDescription(input.description),
    tags: normalizeTags(input.tags),
  };
}

export function validateProjectUpdateInput(value: unknown): ProjectUpdateInput {
  const input = requirePlainObject(value);
  const allowed = new Set(['name', 'description', 'tags', 'status']);
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !allowed.has(key))) {
    throw new ProjectError('Project update must contain at least one supported field.', 'INVALID_PROJECT_INPUT', 400);
  }
  return {
    ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
    ...(input.description !== undefined ? { description: normalizeDescription(input.description) } : {}),
    ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
    ...(input.status !== undefined ? { status: normalizeStatus(input.status) } : {}),
  };
}

export function validateProjectListStatus(value: unknown): ProjectStatus | undefined {
  if (value === undefined || value === 'all') return undefined;
  return normalizeStatus(value);
}

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository = mongooseProjectRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  list(ownerId: string, statusValue?: unknown): Promise<ProjectRecord[]> {
    requireObjectId(ownerId, 'Owner id');
    return this.repository.list(ownerId, validateProjectListStatus(statusValue));
  }

  create(ownerId: string, value: unknown): Promise<ProjectRecord> {
    requireObjectId(ownerId, 'Owner id');
    const input = validateProjectCreateInput(value);
    const timestamp = this.now();
    return this.repository.create({
      ownerId,
      ...input,
      status: 'active',
      activity: [{ type: 'created', timestamp, actorId: ownerId }],
      lastActivityAt: timestamp,
    });
  }

  async get(ownerId: string, projectIdValue: unknown): Promise<ProjectRecord> {
    requireObjectId(ownerId, 'Owner id');
    const projectId = requireObjectId(projectIdValue, 'Project id');
    const project = await this.repository.findByOwnerAndId(ownerId, projectId);
    if (!project) throw new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404);
    return project;
  }

  async resolveOwnedProject(ownerId: string, projectIdValue: unknown): Promise<ProjectRecord | undefined> {
    if (projectIdValue === undefined || projectIdValue === null || projectIdValue === '') return undefined;
    return this.get(ownerId, projectIdValue);
  }

  async resolveActiveProject(ownerId: string, projectIdValue: unknown): Promise<ProjectRecord | undefined> {
    const project = await this.resolveOwnedProject(ownerId, projectIdValue);
    if (!project) return undefined;
    if (project.status === 'archived') {
      throw new ProjectError(
        'Project is archived. Restore it before adding or changing project content.',
        'PROJECT_ARCHIVED',
        409
      );
    }
    return project;
  }

  async update(ownerId: string, projectIdValue: unknown, value: unknown): Promise<ProjectRecord> {
    const projectId = requireObjectId(projectIdValue, 'Project id');
    return projectMutationLease.run(projectId, async () => {
      const current = await this.get(ownerId, projectId);
      const changes = validateProjectUpdateInput(value);
      const timestamp = this.now();
      const events: ProjectActivityInput[] = [];
      if (changes.name !== undefined && changes.name !== current.name) {
        events.push({ type: 'renamed', timestamp, actorId: ownerId, changes: { from: current.name, to: changes.name } });
      }
      if (changes.status !== undefined && changes.status !== current.status) {
        events.push({ type: changes.status === 'archived' ? 'archived' : 'restored', timestamp, actorId: ownerId });
      }
      if (changes.description !== undefined || changes.tags !== undefined) {
        events.push({
          type: 'updated',
          timestamp,
          actorId: ownerId,
          changes: {
            ...(changes.description !== undefined ? { description: true } : {}),
            ...(changes.tags !== undefined ? { tags: true } : {}),
          },
        });
      }
      if (!events.length) events.push({ type: 'updated', timestamp, actorId: ownerId, changes: { noEffectiveChange: true } });
      const project = await this.repository.updateByOwnerAndId(ownerId, projectId, changes, events, timestamp);
      if (!project) throw new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404);
      return project;
    });
  }

  async delete(ownerId: string, projectIdValue: unknown): Promise<ProjectRecord> {
    requireObjectId(ownerId, 'Owner id');
    const projectId = requireObjectId(projectIdValue, 'Project id');
    return projectMutationLease.run(projectId, async () => {
      const project = await this.repository.deleteByOwnerAndId(ownerId, projectId);
      if (!project) throw new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404);
      return project;
    });
  }
}

export interface ProjectDeletionClaims { ownerId: string; projectId: string }
export interface ProjectDeletionConfirmation { confirmationToken: string; expiresAt: string }
export interface ProjectDeletionConfirmationStore {
  issue(claims: ProjectDeletionClaims): ProjectDeletionConfirmation;
  consume(token: unknown, claims: ProjectDeletionClaims): void;
}

interface StoredProjectConfirmation extends ProjectDeletionClaims { expiresAtMs: number }

export class InMemoryProjectDeletionConfirmationStore implements ProjectDeletionConfirmationStore {
  private readonly records = new Map<string, StoredProjectConfirmation>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => randomBytes(32).toString('base64url')
  ) {}

  issue(claims: ProjectDeletionClaims): ProjectDeletionConfirmation {
    this.pruneExpired();
    const confirmationToken = this.createToken();
    const expiresAtMs = this.now() + this.ttlMs;
    this.records.set(this.digest(confirmationToken), { ...claims, expiresAtMs });
    return { confirmationToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(token: unknown, claims: ProjectDeletionClaims): void {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
      throw new ProjectError('A valid project deletion confirmation token is required.', 'INVALID_PROJECT_DELETE_CONFIRMATION', 409);
    }
    const digest = this.digest(token);
    const record = this.records.get(digest);
    if (!record) {
      throw new ProjectError('The project deletion confirmation token is invalid or was already used.', 'INVALID_PROJECT_DELETE_CONFIRMATION', 409);
    }
    if (record.expiresAtMs <= this.now()) {
      this.records.delete(digest);
      throw new ProjectError('The project deletion confirmation token has expired.', 'EXPIRED_PROJECT_DELETE_CONFIRMATION', 409);
    }
    if (record.ownerId !== claims.ownerId || record.projectId !== claims.projectId) {
      throw new ProjectError('The project deletion confirmation token does not match this request.', 'INVALID_PROJECT_DELETE_CONFIRMATION', 409);
    }
    this.records.delete(digest);
  }

  private pruneExpired(): void {
    const currentTime = this.now();
    for (const [digest, record] of this.records) {
      if (record.expiresAtMs <= currentTime) this.records.delete(digest);
    }
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

export const projectService = new ProjectService();
