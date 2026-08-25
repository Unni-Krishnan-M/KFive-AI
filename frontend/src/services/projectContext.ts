export interface ProjectContext {
  projectId: string;
  projectName: string;
}

export interface CanonicalProjectContext extends ProjectContext {
  status: 'active' | 'archived';
}

export const PROJECT_ARCHIVED_MESSAGE = 'Project is archived. Restore it before adding or changing project content.';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;

const cleanProjectId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return /^[a-f\d]{24}$/i.test(id) ? id : undefined;
};

const cleanProjectName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = [...value]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, 120);
  return name || undefined;
};

export function readProjectContext(state: unknown, search = ''): ProjectContext | undefined {
  const navigationState = asRecord(state);
  const query = new URLSearchParams(search);
  const projectId = cleanProjectId(navigationState?.projectId) ?? cleanProjectId(query.get('projectId'));
  if (!projectId) return undefined;

  const projectName = cleanProjectName(navigationState?.projectName)
    ?? cleanProjectName(query.get('projectName'))
    ?? 'Selected project';
  return { projectId, projectName };
}

export function projectContextPath(pathname: string, context: ProjectContext): string {
  const query = new URLSearchParams({ projectId: context.projectId, projectName: context.projectName });
  return `${pathname}?${query.toString()}`;
}

export function projectNavigationState(context: ProjectContext, extra: UnknownRecord = {}): UnknownRecord {
  return { ...extra, projectId: context.projectId, projectName: context.projectName };
}

export function normalizeCanonicalProject(payload: unknown, expectedProjectId: string): CanonicalProjectContext | undefined {
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.data) ?? envelope;
  const project = asRecord(data?.project) ?? data;
  if (!project || project._id !== expectedProjectId || typeof project.name !== 'string') return undefined;
  if (project.status !== 'active' && project.status !== 'archived') return undefined;
  const projectName = cleanProjectName(project.name);
  if (!projectName) return undefined;
  return { projectId: expectedProjectId, projectName, status: project.status };
}
