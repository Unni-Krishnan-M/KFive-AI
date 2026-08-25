import { Types } from 'mongoose';
import { CODE_RUN_LIMITS } from '@/services/codeRunService';
import { CodeRunModel } from './CodeRun';

const userId = new Types.ObjectId();
const projectId = new Types.ObjectId();

function validRun() {
  return new CodeRunModel({
    userId,
    projectId,
    language: 'python',
    runtimeVersion: '3.12',
    source: 'print("hello")',
    stdin: '',
    limits: CODE_RUN_LIMITS,
  });
}

describe('CodeRun model', () => {
  it('validates persisted source, fixed limits, status, and result metadata without MongoDB', async () => {
    const run = validRun();
    await expect(run.validate()).resolves.toBeUndefined();
    expect(run.status).toBe('queued');
    expect(run.queuedAt).toBeInstanceOf(Date);
    expect(run.limits?.networkEnabled).toBe(false);
  });

  it('rejects unsupported language, status, and oversized output', async () => {
    const invalidLanguage = validRun();
    invalidLanguage.language = 'rust' as any;
    await expect(invalidLanguage.validate()).rejects.toThrow('`rust` is not a valid enum value');

    const invalidStatus = validRun();
    invalidStatus.status = 'complete' as any;
    await expect(invalidStatus.validate()).rejects.toThrow('`complete` is not a valid enum value');

    const oversized = validRun();
    oversized.result = { stdout: 'x'.repeat(1_048_577) } as any;
    await expect(oversized.validate()).rejects.toThrow('longer than the maximum allowed length');
  });

  it('declares owner/project/history and worker status indexes', () => {
    const indexes = CodeRunModel.schema.indexes().map(([fields]) => fields);
    expect(indexes).toEqual(expect.arrayContaining([
      { userId: 1, createdAt: -1 },
      { userId: 1, projectId: 1, createdAt: -1 },
      { status: 1, queuedAt: 1 },
    ]));
    expect(CodeRunModel.schema.path('projectId').options.immutable).toBe(true);
    expect(CodeRunModel.schema.path('source').options.immutable).toBe(true);
  });
});
