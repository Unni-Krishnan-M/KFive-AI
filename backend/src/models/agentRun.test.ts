import { Types } from 'mongoose';
import { AgentRunModel } from './AgentRun';

function validRun() {
  return new AgentRunModel({
    ownerId: new Types.ObjectId(),
    agentId: new Types.ObjectId(),
    agentSnapshot: {
      name: 'Reviewer', systemPromptHash: 'a'.repeat(64), requestedModel: 'phi3',
      temperature: 0, tools: [],
    },
    prompt: 'Review this change.', status: 'queued', output: '', outputBytes: 0,
    outputTruncated: false, timeline: [{ sequence: 1, type: 'created', timestamp: new Date() }],
  });
}

describe('AgentRun model', () => {
  it('accepts the strictly typed bounded audit record', async () => {
    await expect(validRun().validate()).resolves.toBeUndefined();
  });

  it('rejects tools, oversized output, invalid usage, and malformed timeline entries', async () => {
    const tools = validRun();
    tools.agentSnapshot!.tools = ['shell'];
    await expect(tools.validate()).rejects.toThrow('tools must be empty');

    const output = validRun();
    output.output = 'x'.repeat(262_145);
    await expect(output.validate()).rejects.toThrow('longer than the maximum allowed length');

    const usage = validRun();
    usage.usage = { inputTokens: 100_000_001 };
    await expect(usage.validate()).rejects.toThrow('more than maximum allowed value');

    const timeline = validRun();
    timeline.timeline = [{ sequence: 0, type: 'created', timestamp: new Date() }] as any;
    await expect(timeline.validate()).rejects.toThrow('less than minimum allowed value');
  });

  it('declares owner/agent/project history and stale-status indexes', () => {
    const indexes = AgentRunModel.schema.indexes().map(([fields]) => fields);
    expect(indexes).toEqual(expect.arrayContaining([
      { ownerId: 1, projectId: 1, createdAt: -1 },
      { ownerId: 1, agentId: 1, createdAt: -1 },
      { status: 1, updatedAt: 1 },
    ]));
    expect(AgentRunModel.schema.path('ownerId').options.immutable).toBe(true);
    expect(AgentRunModel.schema.path('agentId').options.immutable).toBe(true);
  });
});
