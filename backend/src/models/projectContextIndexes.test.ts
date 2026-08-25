import { Agent } from './Agent';
import { Conversation } from './Conversation';
import { DocumentModel } from './Document';

describe('project context indexes', () => {
  it('keeps existing owner/date indexes and adds owner/project/date indexes', () => {
    expect(Conversation.schema.indexes().map(([fields]) => fields)).toEqual(expect.arrayContaining([
      { userId: 1, 'metadata.lastMessageAt': -1 },
      { userId: 1, projectId: 1, 'metadata.lastMessageAt': -1 },
    ]));
    expect(Agent.schema.indexes().map(([fields]) => fields)).toEqual(expect.arrayContaining([
      { userId: 1, updatedAt: -1 },
      { userId: 1, projectId: 1, updatedAt: -1 },
    ]));
    expect(Agent.schema.path('projectId').options.immutable).toBe(true);
    expect(DocumentModel.schema.indexes().map(([fields]) => fields)).toEqual(expect.arrayContaining([
      { userId: 1, createdAt: -1 },
      { userId: 1, projectId: 1, createdAt: -1 },
    ]));
  });
});
