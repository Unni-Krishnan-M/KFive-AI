import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DockerCommandAbortedError,
  DockerCommandAdapter,
  DockerCommandOptions,
  DockerCommandResult,
  DockerOutputLimitError,
} from '../src/dockerCli';
import { DockerCodeExecutor } from '../src/executor';
import { DEFAULT_RUNNER_LIMITS, RunnerLimits, RunnerValidationError } from '../src/types';

const CONTAINER_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface RecordedCall {
  args: readonly string[];
  options: DockerCommandOptions;
}

class FakeDockerAdapter implements DockerCommandAdapter {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly handler: (
      args: readonly string[],
      options: DockerCommandOptions,
      callIndex: number
    ) => Promise<DockerCommandResult> = defaultHandler
  ) {}

  run(args: readonly string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    const callIndex = this.calls.push({ args: [...args], options }) - 1;
    return this.handler(args, options, callIndex);
  }
}

function commandResult(overrides: Partial<DockerCommandResult> = {}): DockerCommandResult {
  return { stdout: '', stderr: '', exitCode: 0, signal: null, ...overrides };
}

async function defaultHandler(args: readonly string[]): Promise<DockerCommandResult> {
  switch (args[0]) {
    case 'create':
      return commandResult({ stdout: `${CONTAINER_ID}\n` });
    case 'start':
      return commandResult({ stdout: 'hello\n' });
    case 'inspect':
      return commandResult({ stdout: '{"ExitCode":0,"OOMKilled":false}' });
    default:
      return commandResult();
  }
}

function limits(overrides: Partial<RunnerLimits> = {}): RunnerLimits {
  return { ...DEFAULT_RUNNER_LIMITS, ...overrides };
}

test('creates Python with the exact hardened, server-owned Docker arguments', async () => {
  const docker = new FakeDockerAdapter();
  const executor = new DockerCodeExecutor(docker);

  const result = await executor.execute({
    runId: 'run_python_1',
    language: 'python',
    source: 'print(input())',
    stdin: 'safe\n',
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.stdout, 'hello\n');
  assert.deepEqual(docker.calls[0].args, [
    'create',
    '--pull', 'never',
    '--name', 'kfive-run-run_python_1',
    '--label', 'com.kfive.code-run=true',
    '--label', 'com.kfive.run-id=run_python_1',
    '--user', '65532:65532',
    '--read-only',
    '--network', 'none',
    '--ipc', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '32',
    '--cpus', '1',
    '--memory', '268435456',
    '--memory-swap', '268435456',
    '--ulimit', 'nofile=64:64',
    '--ulimit', 'nproc=32:32',
    '--ulimit', 'fsize=1048576:1048576',
    '--ulimit', 'core=0:0',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16777216',
    '--workdir', '/workspace',
    '--hostname', 'kfive-run',
    '--env', 'HOME=/tmp',
    '--env', 'LANG=C.UTF-8',
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    '--log-driver', 'none',
    '--stop-timeout', '1',
    '--init',
    'python:3.12-alpine',
    'python3', '-I', '-B', '/workspace/main.py',
  ]);
  assert.equal(docker.calls[1].args[0], 'cp');
  assert.match(String(docker.calls[1].args[1]), /kfive-run-[^/]+\/workspace\/\.$/);
  assert.equal(docker.calls[1].args[2], `${CONTAINER_ID}:/workspace`);
  assert.deepEqual(docker.calls[2].args, ['start', '--attach', '--interactive', CONTAINER_ID]);
  assert.equal(docker.calls[2].options.stdin, 'safe\n');
  assert.deepEqual(docker.calls.at(-2)?.args, ['kill', CONTAINER_ID]);
  assert.deepEqual(docker.calls.at(-1)?.args, ['rm', '--force', '--volumes', CONTAINER_ID]);

  const createArgs = docker.calls[0].args;
  for (const forbidden of ['--privileged', '--mount', '--volume', '-v', '/var/run/docker.sock']) {
    assert.equal(createArgs.includes(forbidden), false, `${forbidden} must not be passed`);
  }
});

test('uses the fixed JavaScript 22 permission-mode command', async () => {
  const docker = new FakeDockerAdapter();
  const executor = new DockerCodeExecutor(docker);

  const result = await executor.execute({ runId: 'js-1', language: 'javascript', source: 'console.log(1)' });

  assert.equal(result.runtimeVersion, '22');
  assert.deepEqual(docker.calls[0].args.slice(-5), [
    'node:22-alpine',
    'node',
    '--permission',
    '--allow-fs-read=/workspace/main.js',
    '/workspace/main.js',
  ]);
});

test('rejects arbitrary languages and request-provided limits before Docker is called', async () => {
  const docker = new FakeDockerAdapter();
  const executor = new DockerCodeExecutor(docker);

  await assert.rejects(
    executor.execute({ runId: 'x', language: 'ruby', source: 'puts 1' }),
    RunnerValidationError
  );
  await assert.rejects(
    executor.execute({ runId: 'x', language: 'python', source: 'print(1)', limits: { timeoutMs: 999999 } }),
    /Unknown execution fields: limits/
  );
  assert.equal(docker.calls.length, 0);
});

test('rejects unsafe trusted configuration limits', () => {
  const docker = new FakeDockerAdapter();
  assert.throws(
    () => new DockerCodeExecutor(docker, limits({ timeoutMs: 30_001 })),
    /Timeout exceeds/
  );
  assert.throws(
    () => new DockerCodeExecutor(docker, limits({ memoryBytes: 2 * 1024 * 1024 * 1024 })),
    /Memory limit/
  );
  assert.throws(
    () => new DockerCodeExecutor(docker, limits({ cpuCores: 4 })),
    /CPU limit/
  );
});

test('enforces UTF-8 source and stdin byte limits before Docker is called', async () => {
  const docker = new FakeDockerAdapter();
  const executor = new DockerCodeExecutor(docker, limits({ sourceBytes: 4, stdinBytes: 4 }));

  await assert.rejects(
    executor.execute({ runId: 'source', language: 'python', source: 'ééé' }),
    /Source must/
  );
  await assert.rejects(
    executor.execute({ runId: 'stdin', language: 'python', source: 'x', stdin: 'ééé' }),
    /stdin exceeds/
  );
  assert.equal(docker.calls.length, 0);
});

test('returns a typed timeout and always force-cleans the container', async () => {
  const docker = new FakeDockerAdapter(async (args, options) => {
    if (args[0] === 'create') return commandResult({ stdout: CONTAINER_ID });
    if (args[0] === 'start') {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DockerCommandAbortedError('aborted', 'partial', ''));
        }, { once: true });
      });
    }
    return commandResult();
  });
  const executor = new DockerCodeExecutor(docker, limits({ timeoutMs: 10 }));

  const result = await executor.execute({ runId: 'timeout', language: 'python', source: 'while True: pass' });

  assert.equal(result.status, 'timed_out');
  assert.equal(result.errorCode, 'TIMEOUT');
  assert.equal(result.stdout, 'partial');
  assert.deepEqual(docker.calls.at(-2)?.args, ['kill', CONTAINER_ID]);
  assert.deepEqual(docker.calls.at(-1)?.args, ['rm', '--force', '--volumes', CONTAINER_ID]);
});

test('returns a typed cancellation and cleans an active container', async () => {
  const cancellation = new AbortController();
  const docker = new FakeDockerAdapter(async (args, options) => {
    if (args[0] === 'create') return commandResult({ stdout: CONTAINER_ID });
    if (args[0] === 'start') {
      setImmediate(() => cancellation.abort());
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DockerCommandAbortedError('aborted', '', 'cancelled output'));
        }, { once: true });
      });
    }
    return commandResult();
  });
  const executor = new DockerCodeExecutor(docker);

  const result = await executor.execute(
    { runId: 'cancel', language: 'javascript', source: 'setInterval(() => {}, 1000)' },
    cancellation.signal
  );

  assert.equal(result.status, 'cancelled');
  assert.equal(result.errorCode, 'CANCELLED');
  assert.equal(result.stderr, 'cancelled output');
  assert.deepEqual(docker.calls.at(-1)?.args, ['rm', '--force', '--volumes', CONTAINER_ID]);
});

test('caps output, marks truncation, and cleans the container', async () => {
  const docker = new FakeDockerAdapter(async (args) => {
    if (args[0] === 'create') return commandResult({ stdout: CONTAINER_ID });
    if (args[0] === 'start') {
      throw new DockerOutputLimitError('too much output', 'x'.repeat(32), '');
    }
    return commandResult();
  });
  const executor = new DockerCodeExecutor(docker, limits({ outputBytes: 32 }));

  const result = await executor.execute({ runId: 'output', language: 'python', source: 'while True: print("x")' });

  assert.equal(result.status, 'output_limit');
  assert.equal(result.errorCode, 'OUTPUT_LIMIT');
  assert.equal(result.outputTruncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 32);
  assert.deepEqual(docker.calls.at(-1)?.args, ['rm', '--force', '--volumes', CONTAINER_ID]);
});

test('cleans a created container when source copy fails', async () => {
  const docker = new FakeDockerAdapter(async (args) => {
    if (args[0] === 'create') return commandResult({ stdout: CONTAINER_ID });
    if (args[0] === 'cp') throw new Error('copy failed');
    return commandResult();
  });
  const executor = new DockerCodeExecutor(docker);

  const result = await executor.execute({ runId: 'copy-fail', language: 'python', source: 'print(1)' });

  assert.equal(result.status, 'internal_error');
  assert.equal(result.errorCode, 'RUNNER_INTERNAL_ERROR');
  assert.deepEqual(docker.calls.at(-2)?.args, ['kill', CONTAINER_ID]);
  assert.deepEqual(docker.calls.at(-1)?.args, ['rm', '--force', '--volumes', CONTAINER_ID]);
});

test('classifies Docker OOM state as resource exhaustion', async () => {
  const docker = new FakeDockerAdapter(async (args) => {
    if (args[0] === 'create') return commandResult({ stdout: CONTAINER_ID });
    if (args[0] === 'start') return commandResult({ exitCode: 137 });
    if (args[0] === 'inspect') return commandResult({ stdout: '{"ExitCode":137,"OOMKilled":true}' });
    return commandResult();
  });
  const executor = new DockerCodeExecutor(docker);

  const result = await executor.execute({ runId: 'oom', language: 'javascript', source: 'new ArrayBuffer(1e12)' });

  assert.equal(result.status, 'resource_exceeded');
  assert.equal(result.errorCode, 'OOM_KILLED');
  assert.equal(result.oomKilled, true);
  assert.equal(result.exitCode, 137);
});
