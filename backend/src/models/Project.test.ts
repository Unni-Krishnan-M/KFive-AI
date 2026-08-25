import { Types } from 'mongoose';
import { ProjectModel } from './Project';

const ownerId = new Types.ObjectId();

function validProject() {
  return new ProjectModel({
    ownerId,
    name: 'KFive Platform',
    description: 'Local-first workspace',
    tags: ['ai', 'platform'],
    activity: [{ type: 'created', actorId: ownerId, timestamp: new Date() }],
  });
}

describe('Project model', () => {
  it('validates a bounded owner-scoped project without connecting to MongoDB', async () => {
    const project = validProject();
    await expect(project.validate()).resolves.toBeUndefined();
    expect(project.status).toBe('active');
    expect(project.lastActivityAt).toBeInstanceOf(Date);
  });

  it('rejects invalid status, duplicate tags, and oversized activity', async () => {
    const duplicateTags = validProject();
    duplicateTags.tags = ['AI', 'ai'];
    await expect(duplicateTags.validate()).rejects.toThrow('Project tags must be unique');

    const invalidStatus = validProject();
    invalidStatus.status = 'deleted' as any;
    await expect(invalidStatus.validate()).rejects.toThrow('`deleted` is not a valid enum value');

    const tooMuchActivity = validProject();
    tooMuchActivity.activity = Array.from({ length: 101 }, () => ({
      type: 'updated', actorId: ownerId, timestamp: new Date(),
    })) as any;
    await expect(tooMuchActivity.validate()).rejects.toThrow('cannot exceed 100 events');
  });

  it('declares owner/status/activity indexes for scoped lists', () => {
    const indexes = ProjectModel.schema.indexes().map(([fields]) => fields);
    expect(indexes).toContainEqual({ ownerId: 1, status: 1, lastActivityAt: -1 });
    expect(indexes).toContainEqual({ ownerId: 1, updatedAt: -1 });
  });
});

