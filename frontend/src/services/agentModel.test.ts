import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_OUTPUT_BYTES,
  buildAgentPayload,
  normalizeAgent,
  normalizeAgentRunDetail,
  normalizeAgentRunDeletion,
  normalizeAgentRunList,
  normalizeAgentRunPage,
  normalizeAgentRunTimeline,
  normalizeAgentRunUsage,
} from './agentModel';

const summary = {
  id: 'run-1', agentId: 'agent-1', status: 'succeeded',
  agent: { name: 'Reviewer', requestedModel: 'phi3', temperature: 0.2, tools: [] },
  provider: 'ollama', model: 'phi3', outputBytes: 11, outputTruncated: false,
  queuedAt: '2026-08-25T10:00:00.000Z', completedAt: '2026-08-25T10:00:01.000Z',
};

describe('agent API normalization', () => {
  it('uses backend aiModel records', () => {
    expect(normalizeAgent({
      id: 'agent-1', _id: 'legacy-ignored', name: 'Reviewer', description: 'Reviews', systemPrompt: 'Review code', aiModel: 'phi3', temperature: 0.2, tools: [],
    })).toMatchObject({ id: 'agent-1', aiModel: 'phi3', temperature: 0.2, tools: [], toolState: 'disabled' });
  });

  it('tolerates legacy model-shaped records', () => {
    expect(normalizeAgent({ _id: 'agent-2', name: 'Writer', systemPrompt: 'Write', model: 'mistral' }))
      .toMatchObject({ id: 'agent-2', aiModel: 'mistral', description: '', temperature: 0.7 });
  });

  it('builds the backend payload with project association and no legacy model field', () => {
    expect(buildAgentPayload({ name: ' Reviewer ', systemPrompt: ' Review ', model: 'phi3', temperature: 0.3 }, 'project-1'))
      .toEqual({ name: 'Reviewer', description: '', systemPrompt: 'Review', aiModel: 'phi3', temperature: 0.3, tools: [], projectId: 'project-1' });
  });

  it('rejects enabled tools and out-of-contract agent fields', () => {
    expect(normalizeAgent({ id: 'agent-1', name: 'Agent', systemPrompt: 'Act', tools: ['shell'] })).toBeUndefined();
    expect(normalizeAgent({ id: 'agent-1', name: 'Agent', systemPrompt: 'Act', temperature: 3, tools: [] })).toBeUndefined();
  });

  it('retains only the safe legacy tool state marker', () => {
    expect(normalizeAgent({ id: 'agent-1', name: 'Agent', systemPrompt: 'Act', tools: [], toolState: 'legacy-blocked' }))
      .toMatchObject({ tools: [], toolState: 'legacy-blocked' });
  });

  it('normalizes bounded run summaries and details from API envelopes', () => {
    expect(normalizeAgentRunList({ success: true, data: { runs: [summary] } })).toEqual([expect.objectContaining({ id: 'run-1', status: 'succeeded' })]);
    expect(normalizeAgentRunDetail({ data: { run: {
      ...summary, prompt: 'Review this', output: 'Looks good.',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, totalDurationMs: 100 },
      timeline: [{ sequence: 1, type: 'created', timestamp: '2026-08-25T10:00:00.000Z' }],
    } } })).toMatchObject({ output: 'Looks good.', usage: { totalTokens: 5 }, timeline: [{ type: 'created' }] });
  });

  it('normalizes the bounded paginated run and deletion contracts', () => {
    expect(normalizeAgentRunPage({ data: {
      runs: [summary], pagination: { page: 1, pageSize: 50, total: 51, totalPages: 2 },
    } })).toEqual({
      runs: [expect.objectContaining({ id: 'run-1' })],
      pagination: { page: 1, pageSize: 50, total: 51, totalPages: 2 },
    });
    expect(normalizeAgentRunDeletion({ success: true, data: { runId: 'run-1', deleted: true } }))
      .toEqual({ runId: 'run-1', deleted: true });
  });

  it('rejects pagination beyond the 50-by-10 retention boundary', () => {
    expect(normalizeAgentRunPage({ data: { runs: [], pagination: { page: 11, pageSize: 50, total: 500, totalPages: 10 } } })).toBeUndefined();
    expect(normalizeAgentRunPage({ data: { runs: [], pagination: { page: 1, pageSize: 51, total: 0, totalPages: 1 } } })).toBeUndefined();
    expect(normalizeAgentRunPage({ data: { runs: [], pagination: { page: 1, pageSize: 50, total: 501, totalPages: 11 } } })).toBeUndefined();
    expect(normalizeAgentRunDeletion({ data: { runId: 'run-1', deleted: false } })).toBeUndefined();
  });

  it('rejects malformed or oversized run data instead of coercing it', () => {
    expect(normalizeAgentRunList({ data: { runs: [{ ...summary, status: 'invented' }] } })).toEqual([]);
    expect(normalizeAgentRunDetail({ ...summary, prompt: 'Prompt', output: 'x'.repeat(AGENT_RUN_OUTPUT_BYTES + 1), timeline: [] })).toBeUndefined();
    expect(normalizeAgentRunUsage({ totalTokens: 200_000_001 })).toBeUndefined();
    expect(normalizeAgentRunTimeline([{ sequence: 0, type: 'created', timestamp: summary.queuedAt }])).toBeUndefined();
  });
});
