/* Dedicated ephemeral Redis: never connects to the application's queue. */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Queue, QueueEvents } = require('bullmq');
const { createClient } = require('redis');
const { ExecFileDockerAdapter } = require('../services/code-runner/dist/src/dockerCli');
const { DockerCodeExecutor } = require('../services/code-runner/dist/src/executor');
const { BullMqWorkerFactory, CODE_RUN_QUEUE } = require('../services/code-runner/dist/src/queueWorker');
const { CodeRunnerWorkerHost } = require('../services/code-runner/dist/src/workerHost');
const { RedisRunnerCoordinator, RUNNER_HEARTBEAT_KEY, RUNNER_CANCEL_CHANNEL, RUNNER_CANCEL_KEY_PREFIX } = require('../services/code-runner/dist/src/coordinator');

async function main() {
  assert.ok(process.argv.includes('--allow-live-test'), 'Pass --allow-live-test.');
  const docker = new ExecFileDockerAdapter();
  const name = `kfive-queue-verify-${randomUUID()}`;
  let containerId, client, queue, events, host;
  const errors = [];
  async function command(args) {
    const result = await docker.run(args, { timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, `Docker ${args[0]} failed`);
    return result.stdout.trim();
  }
  try {
    containerId = await command(['create', '--pull', 'never', '--name', name,
      '--label', 'com.kfive.verification=code-queue', '--user', '999:999',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--memory', '96m', '--memory-swap', '96m', '--cpus', '0.5', '--pids-limit', '32',
      '--tmpfs', '/data:rw,noexec,nosuid,nodev,size=16777216,uid=999,gid=999',
      '-p', '127.0.0.1::6379', 'redis:7.2-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
    assert.match(containerId, /^[a-f0-9]{64}$/);
    await command(['start', containerId]);
    const [inspection] = JSON.parse(await command(['inspect', containerId]));
    const binding = inspection.NetworkSettings.Ports['6379/tcp'][0];
    assert.equal(binding.HostIp, '127.0.0.1');
    const connection = { host: '127.0.0.1', port: Number(binding.HostPort), db: 0, maxRetriesPerRequest: null };
    client = createClient({ socket: { host: connection.host, port: connection.port, connectTimeout: 3000, reconnectStrategy: false } });
    client.on('error', () => errors.push('redis-client-error'));
    await client.connect();
    queue = new Queue(CODE_RUN_QUEUE, { connection });
    events = new QueueEvents(CODE_RUN_QUEUE, { connection });
    events.on('error', () => errors.push('queue-event-error'));
    await events.waitUntilReady();
    function newHost() {
      return new CodeRunnerWorkerHost(new BullMqWorkerFactory(connection, 1, event => errors.push(event)),
        new RedisRunnerCoordinator(connection, event => errors.push(event)), new DockerCodeExecutor(docker),
        { concurrency: 1, onError: event => errors.push(event) });
    }
    host = newHost();
    await host.start();
    assert.ok(Date.now() - Number(await client.get(RUNNER_HEARTBEAT_KEY)) < 5000);
    const id = randomUUID();
    const job = await queue.add('execute', { runId: id, language: 'python', source: 'print(input())', stdin: 'queue-ok\n' }, { jobId: id });
    const result = await job.waitUntilFinished(events, 15000);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stdout, 'queue-ok\n');
    await host.stop();
    host = newHost();
    await host.start();
    const saved = await queue.getJob(id);
    assert.equal(await saved.getState(), 'completed');
    assert.equal(saved.returnvalue.stdout, 'queue-ok\n');
    console.log('PASS: real Redis dispatch -> worker -> Docker -> retained queue result across worker restart.');
    const cancelId = randomUUID();
    const cancelJob = await queue.add('execute', { runId: cancelId, language: 'python', source: 'while True: pass', stdin: '' }, { jobId: cancelId });
    const completion = cancelJob.waitUntilFinished(events, 15000);
    // Attach the rejection handler immediately while waiting for active state.
    completion.catch(() => undefined);
    for (let i = 0; i < 100 && await cancelJob.getState() !== 'active'; i++) await delay(20);
    assert.equal(await cancelJob.getState(), 'active');
    await client.set(`${RUNNER_CANCEL_KEY_PREFIX}${cancelId}`, '1', { EX: 60 });
    await client.publish(RUNNER_CANCEL_CHANNEL, cancelId);
    assert.equal((await completion).status, 'cancelled');
    assert.equal(await client.exists(`${RUNNER_CANCEL_KEY_PREFIX}${cancelId}`), 0);
    assert.equal(await command(['ps', '-aq', '--filter', `label=com.kfive.run-id=${cancelId}`]), '');
    assert.deepEqual(errors, []);
    console.log('PASS: Redis cancellation reaches worker; cancellation key and runtime container removed.');
  } finally {
    await host?.stop();
    await events?.close();
    await queue?.close();
    if (client?.isOpen) await client.quit();
    if (containerId) await command(['rm', '--force', '--volumes', containerId]);
  }
  console.log('PASS: disposable Redis removed; application data untouched.');
}
main().catch(() => { console.error('Code queue live verification failed; no credentials logged.'); process.exitCode = 1; });
