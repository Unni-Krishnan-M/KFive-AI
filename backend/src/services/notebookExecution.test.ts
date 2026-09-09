import { createHash } from 'node:crypto';
import { NotebookDockerClient, NotebookDockerResult } from './notebookDocker';
import { DockerNotebookExecutor, notebookInput, runtimeCreateArgs, verifierCreateArgs } from './notebookExecution';

const runtimeId = 'a'.repeat(64);
const verifierId = 'b'.repeat(64);
const runtimeContainer = 'c'.repeat(64);
const verifierContainer = 'd'.repeat(64);
const runId = '64b000000000000000000301';

const result = (stdout = '', exitCode = 0): NotebookDockerResult => ({ stdout, stderr: '', exitCode, signal: null });
function successfulEnvelope(): string {
  const executed = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] };
  const files = [
    { path: 'executed.ipynb', data: Buffer.from(`${JSON.stringify(executed)}\n`) },
    { path: 'result.json', data: Buffer.from(`${JSON.stringify({
    schemaVersion: 'kfive.notebook-result.v1', runId, status: 'succeeded',
    startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:00.010Z', durationMs: 10,
    notebookFile: 'executed.ipynb', metrics: [], artifacts: [], error: null,
    })}\n`) },
  ];
  return `${JSON.stringify({ schemaVersion: 'kfive.notebook-files.v1', files: files.map(({ path, data }) => ({
    path, data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'),
  })) })}\n`;
}

class FakeDocker implements NotebookDockerClient {
  calls: string[][] = [];
  constructor(private readonly verifierExit = 0) {}
  async run(args: readonly string[]): Promise<NotebookDockerResult> {
    const call = [...args]; this.calls.push(call);
    if (call[0] === 'image' && call.includes('runtime:test')) return result(`sha256:${runtimeId}\n`);
    if (call[0] === 'image' && call.includes('verifier:test')) return result(`sha256:${verifierId}\n`);
    if (call[0] === 'create' && call.includes('runtime:test')) return result(`${runtimeContainer}\n`);
    if (call[0] === 'create' && call.includes('verifier:test')) return result(`${verifierContainer}\n`);
    if (call[0] === 'inspect') return result('{"OOMKilled":false,"ExitCode":0}\n');
    if (call[0] === 'exec' && call.includes('kfive_notebook_runtime.exporter')) return result(successfulEnvelope());
    if (call[0] === 'exec' && call.includes('kfive_notebook_runtime.verifier')) return result('', this.verifierExit);
    return result();
  }
}

const request = { runId, cellTimeoutSeconds: 10,
  cells: [{ id: 'cell_one', type: 'code' as const, source: 'print(1)', tags: [] }] };

describe('DockerNotebookExecutor', () => {
  it('canonicalizes empty cell tags before immutable identity verification', () => {
    expect(notebookInput(request.cells).cells[0].metadata).toEqual({});
    expect(notebookInput([{ ...request.cells[0], tags: ['training'] }]).cells[0].metadata).toEqual({ tags: ['training'] });
  });

  it('enforces resource, network, privilege, and mount isolation in both stages', () => {
    const runtime = runtimeCreateArgs('runtime-name', 'runtime:test', {
      requireAppArmor: true, memoryBytes: 768 * 1024 * 1024, cpuCores: 1, processLimit: 128,
    });
    expect(runtime).toEqual(expect.arrayContaining(['--read-only', '--network', 'none', '--ipc', 'none',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--security-opt', 'apparmor=docker-default',
      '--user', '10001:10001', '--pids-limit', '128', '--entrypoint', '/usr/bin/sleep']));
    expect(runtime.join(' ')).not.toContain('docker.sock');
    const verifier = verifierCreateArgs('verifier-name', 'verifier:test', true);
    expect(verifier).toEqual(expect.arrayContaining(['--read-only', '--network', 'none', '--user', '10002:10002',
      '--entrypoint', '/usr/bin/sleep']));
    expect(verifier.join(' ')).not.toContain('docker.sock');
  });

  it('removes the stopped runtime before it creates the independent verifier', async () => {
    const docker = new FakeDocker();
    const output = await new DockerNotebookExecutor(docker, { runtimeImage: 'runtime:test', verifierImage: 'verifier:test' }).execute(request);
    expect(output).toMatchObject({ status: 'succeeded', runtimeImageId: runtimeId, verifierImageId: verifierId,
      executedNotebookJson: expect.any(String), metrics: [], artifacts: [] });
    const runtimeRemove = docker.calls.findIndex((call) => call[0] === 'rm' && call.includes(runtimeContainer));
    const verifierCreate = docker.calls.findIndex((call) => call[0] === 'create' && call.includes('verifier:test'));
    expect(runtimeRemove).toBeGreaterThan(-1);
    expect(verifierCreate).toBeGreaterThan(runtimeRemove);
    expect(docker.calls.filter((call) => call[0] === 'create')).toHaveLength(2);
  });

  it('never accepts output when the verifier rejects it and cleans both containers', async () => {
    const docker = new FakeDocker(1);
    await expect(new DockerNotebookExecutor(docker, { runtimeImage: 'runtime:test', verifierImage: 'verifier:test' }).execute(request))
      .rejects.toMatchObject({ code: 'NOTEBOOK_ISOLATION_FAILED' });
    expect(docker.calls.some((call) => call[0] === 'rm' && call.includes(runtimeContainer))).toBe(true);
    expect(docker.calls.some((call) => call[0] === 'rm' && call.includes(verifierContainer))).toBe(true);
  });

  it('does not create a user-code container for an already-cancelled request', async () => {
    const docker = new FakeDocker(); const controller = new AbortController(); controller.abort();
    await expect(new DockerNotebookExecutor(docker, { runtimeImage: 'runtime:test', verifierImage: 'verifier:test' })
      .execute(request, controller.signal)).resolves.toMatchObject({ status: 'cancelled' });
    expect(docker.calls.some((call) => call[0] === 'create')).toBe(false);
  });

  it('rejects mutable ambiguity where both stages resolve to one image', async () => {
    const docker = new FakeDocker();
    docker.run = jest.fn(async (args: readonly string[]) => args[0] === 'image'
      ? result(`sha256:${runtimeId}\n`) : result());
    await expect(new DockerNotebookExecutor(docker, { runtimeImage: 'runtime:test', verifierImage: 'verifier:test' })
      .execute(request)).rejects.toThrow('same image');
  });
});
