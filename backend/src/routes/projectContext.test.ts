import { Router } from 'express';
import { Agent } from '@/models/Agent';
import { Conversation } from '@/models/Conversation';
import { DocumentModel } from '@/models/Document';
import { ProjectError, projectService } from '@/services/projectService';
import { errorHandler } from '@/middleware/errorHandler';
import { logger } from '@/utils/logger';
import agentRouter from './agent';
import chatRouter from './chat';
import documentRouter, { documentRecordFromUpload, resolveUploadedProjectContext } from './document';

const ownerId = '64b000000000000000000001';
const projectId = '64b000000000000000000101';
const project = {
  _id: projectId,
  ownerId,
  name: 'KFive',
  description: '',
  tags: [],
  status: 'active' as const,
};

function invoke(
  router: Router,
  method: 'get' | 'post',
  path: string,
  values: { body?: any; query?: any; params?: any } = {}
): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    handler({
      body: values.body || {},
      query: values.query || {},
      params: values.params || {},
      user: { userId: ownerId, email: 'owner@example.com', role: 'user' },
    }, {
      status(code: number) { status = code; return this; },
      json(body: any) { resolve({ status, body }); return this; },
    }, reject);
  });
}

describe('project context on chat, agents, and documents', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stores validated project context on new conversations and agents', async () => {
    jest.spyOn(projectService, 'resolveActiveProject').mockResolvedValue(project);
    const createConversation = jest.spyOn(Conversation, 'create').mockResolvedValue({ _id: 'conversation' } as any);
    const createAgent = jest.spyOn(Agent, 'create').mockResolvedValue({ _id: 'agent' } as any);

    await invoke(chatRouter, 'post', '/conversations', {
      body: { title: 'Project chat', projectId },
    });
    await invoke(agentRouter, 'post', '/', {
      body: { name: 'Reviewer', systemPrompt: 'Review safely.', projectId },
    });

    expect(projectService.resolveActiveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(createConversation).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, projectId }));
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, projectId }));
  });

  it('uses validated owner/project filters for conversation, agent, and document lists', async () => {
    jest.spyOn(projectService, 'resolveOwnedProject').mockResolvedValue(project);
    const findConversations = jest.spyOn(Conversation, 'find').mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
    } as any);
    jest.spyOn(Conversation, 'countDocuments').mockResolvedValue(0);
    const findAgents = jest.spyOn(Agent, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
    } as any);
    const findDocuments = jest.spyOn(DocumentModel, 'find').mockReturnValue({ sort: () => Promise.resolve([]) } as any);

    await invoke(chatRouter, 'get', '/conversations', { query: { projectId } });
    await invoke(agentRouter, 'get', '/', { query: { projectId } });
    await invoke(documentRouter, 'get', '/', { query: { projectId } });

    const expectedFilter = { userId: ownerId, projectId };
    expect(findConversations).toHaveBeenCalledWith(expectedFilter);
    expect(Conversation.countDocuments).toHaveBeenCalledWith(expectedFilter);
    expect(findAgents).toHaveBeenCalledWith(expectedFilter);
    expect(findDocuments).toHaveBeenCalledWith(expectedFilter);
  });

  it('allows an owner to filter and read records for an archived project', async () => {
    const archivedProject = { ...project, status: 'archived' as const };
    const resolveOwned = jest.spyOn(projectService, 'resolveOwnedProject').mockResolvedValue(archivedProject);
    const resolveActive = jest.spyOn(projectService, 'resolveActiveProject');
    jest.spyOn(Conversation, 'find').mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
    } as any);
    jest.spyOn(Conversation, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Agent, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
    } as any);
    jest.spyOn(DocumentModel, 'find').mockReturnValue({ sort: () => Promise.resolve([]) } as any);

    await expect(invoke(chatRouter, 'get', '/conversations', { query: { projectId } })).resolves.toMatchObject({ status: 200 });
    await expect(invoke(agentRouter, 'get', '/', { query: { projectId } })).resolves.toMatchObject({ status: 200 });
    await expect(invoke(documentRouter, 'get', '/', { query: { projectId } })).resolves.toMatchObject({ status: 200 });
    expect(resolveOwned).toHaveBeenCalledTimes(3);
    expect(resolveActive).not.toHaveBeenCalled();
  });

  it('stops persistence when project context is archived', async () => {
    const archived = new ProjectError(
      'Project is archived. Restore it before adding or changing project content.',
      'PROJECT_ARCHIVED',
      409
    );
    jest.spyOn(projectService, 'resolveActiveProject').mockRejectedValue(archived);
    const createConversation = jest.spyOn(Conversation, 'create');

    await expect(invoke(chatRouter, 'post', '/conversations', {
      body: { title: 'Blocked', projectId },
    })).rejects.toBe(archived);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it('blocks chat mutation and agent execution for archived project records', async () => {
    const archived = new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409);
    const resolveActive = jest.spyOn(projectService, 'resolveActiveProject').mockRejectedValue(archived);
    jest.spyOn(Conversation, 'findOne').mockResolvedValue({
      projectId: { toString: () => projectId },
      messages: [],
    } as any);
    jest.spyOn(Agent, 'findOne').mockResolvedValue({
      projectId: { toString: () => projectId },
      systemPrompt: 'Review.',
      aiModel: 'phi3',
      temperature: 0.7,
    } as any);

    await expect(invoke(chatRouter, 'post', '/conversations/:id/messages', {
      params: { id: '64b000000000000000000301' },
      body: { role: 'user', content: 'Blocked' },
    })).rejects.toBe(archived);
    await expect(invoke(agentRouter, 'post', '/:id/execute', {
      params: { id: '64b000000000000000000201' },
      body: { prompt: 'Blocked' },
    })).rejects.toBe(archived);
    expect(resolveActive).toHaveBeenCalledTimes(2);
  });

  it('serializes archived context as a typed HTTP conflict', () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const archived = new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409);
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    errorHandler(archived, {
      url: '/api/v1/chat/conversations',
      originalUrl: '/api/v1/chat/conversations',
      method: 'POST',
      ip: '127.0.0.1',
      get: () => undefined,
    } as any, { status, json } as any, jest.fn());
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'PROJECT_ARCHIVED', message: 'Project is archived.' }),
    }));
  });

  it('removes an uploaded temporary file when project validation fails', async () => {
    const archived = new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409);
    const resolveProject = jest.fn().mockRejectedValue(archived);
    const removeFile = jest.fn().mockResolvedValue(undefined);

    await expect(resolveUploadedProjectContext(
      ownerId,
      projectId,
      '/tmp/kfive-upload.pdf',
      resolveProject,
      removeFile
    )).rejects.toBe(archived);
    expect(resolveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(removeFile).toHaveBeenCalledWith('/tmp/kfive-upload.pdf');
  });

  it('stores the canonical validated project id in a document record', () => {
    const file = {
      originalname: '../unsafe name.pdf',
      filename: 'random.pdf',
      mimetype: 'application/pdf',
      size: 123,
      path: '/tmp/random.pdf',
    } as Express.Multer.File;
    expect(documentRecordFromUpload(ownerId, file, project)).toMatchObject({
      userId: ownerId,
      projectId,
      originalName: 'unsafe name.pdf',
      status: 'pending',
    });
  });
});
