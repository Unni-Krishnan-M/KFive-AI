/* Opt-in real Docker check; creates only disposable runner-owned containers. */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DockerCodeExecutor } = require('../services/code-runner/dist/src/executor');
const { ExecFileDockerAdapter } = require('../services/code-runner/dist/src/dockerCli');
const { DEFAULT_RUNNER_LIMITS } = require('../services/code-runner/dist/src/types');

async function main() {
  assert.ok(process.argv.includes('--allow-live-test'), 'Pass --allow-live-test to create isolated test containers.');
  const docker = new ExecFileDockerAdapter();
  const image = await docker.run(['image', 'inspect', 'python:3.12-alpine', '--format', '{{.Id}}']);
  assert.equal(image.exitCode, 0, 'Pre-pull the allowlisted Python image.');
  console.log(`Python image: ${image.stdout.trim()}`);
  const ownedContainers = new Set();
  const adapter = { async run(args, options) {
    const response = await docker.run(args, options);
    if (args[0] === 'create' && response.exitCode === 0) {
      assert.match(response.stdout.trim(), /^[a-f0-9]{64}$/);
      ownedContainers.add(response.stdout.trim());
      const inspected = await docker.run(['inspect', response.stdout.trim()]);
      const [container] = JSON.parse(inspected.stdout);
      const host = container.HostConfig;
      assert.equal(container.Config.User, '65532:65532');
      assert.equal(container.Config.OpenStdin, true);
      assert.equal(host.ReadonlyRootfs, true);
      assert.equal(host.NetworkMode, 'none');
      assert.equal(host.Privileged, false);
      assert.equal(host.PidsLimit, 32);
      assert.equal(host.Memory, 268435456);
      assert.equal(host.MemorySwap, host.Memory);
      assert.equal(host.NanoCpus, 1000000000);
      assert.deepEqual(host.CapDrop, ['ALL']);
      assert.ok(host.SecurityOpt.includes('no-new-privileges:true'));
      assert.equal((host.Binds ?? []).length, 0);
      assert.equal((host.Devices ?? []).length, 0);
      assert.equal((host.DeviceRequests ?? []).length, 0);
      assert.ok(container.Mounts.every(mount => mount.Type === 'tmpfs'));
    }
    if (response.exitCode !== 0 && !['kill', 'rm'].includes(args[0])) {
      console.error(`Test Docker ${args[0]}: ${response.stderr}`);
    }
    return response;
  } };
  async function check(name, request, verify, limits = {}, signal) {
    const runId = `verify-${randomUUID()}`;
    const executor = new DockerCodeExecutor(adapter, { ...DEFAULT_RUNNER_LIMITS, ...limits });
    let result;
    try {
      result = await executor.execute({ runId, ...request }, signal);
      const remaining = await docker.run(['ps', '-aq', '--filter', `label=com.kfive.run-id=${runId}`]);
      assert.equal(remaining.exitCode, 0);
      assert.equal(remaining.stdout.trim(), '', 'Executor must remove the test container before verifier cleanup.');
    } finally {
      // Also clean up if this verifier's inspection assertions fail before
      // the executor receives the created ID. Never target unrelated runs.
      for (const id of ownedContainers) {
        await docker.run(['rm', '--force', '--volumes', id], { timeoutMs: 5000 });
      }
      ownedContainers.clear();
    }
    verify(result);
    console.log(`PASS: ${name}; configuration inspected and container removed.`);
  }
  const success = expected => result => {
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.stdout, expected);
    assert.equal(result.exitCode, 0);
  };
  await check('Python stdin/EOF', { language: 'python', source: 'import sys; print("received:" + sys.stdin.read())', stdin: 'kfive-stdin' }, success('received:kfive-stdin\n'));
  await check('Python main module', { language: 'python', source: 'import __main__,sys\nclass Item: pass\nassert __main__.Item is Item\nassert __package__ is None\nassert sys.argv == [__file__]\nprint(__name__)' }, success('__main__\n'));
  await check('Python Unicode and multi-chunk source', { language: 'python', source: '#'+ '😀'.repeat(15000) + '\nprint("é😀")' }, success('é😀\n'));
  const jsImage = await docker.run(['image', 'inspect', 'node:22-alpine', '--format', '{{.Id}}']);
  assert.equal(jsImage.exitCode, 0, 'Pre-pull node:22-alpine.');
  console.log(`JavaScript image: ${jsImage.stdout.trim()}`);
  await check('JavaScript stdin and main module', { language: 'javascript', source: 'const assert=require("node:assert/strict");assert.equal(require.main,module);assert.deepEqual(process.argv,[process.execPath,__filename]);console.log(require("node:fs").readFileSync(0,"utf8"));', stdin: 'héllo' }, success('héllo\n'));
  await check('stderr and nonzero exit', { language: 'python', source: 'import sys; print("failure",file=sys.stderr); sys.exit(7)' }, result => {
    assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7); assert.equal(result.stderr, 'failure\n');
  });
  await check('timeout', { language: 'python', source: 'while True: pass' }, result => assert.equal(result.status, 'timed_out'), { timeoutMs: 1000 });
  await check('output cap', { language: 'python', source: 'while True: print("x"*1000)' }, result => {
    assert.equal(result.status, 'output_limit'); assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 4096);
  }, { outputBytes: 4096 });
  await check('kernel memory limit', { language: 'python', source: 'blocks=[]\nwhile True: blocks.append(bytearray(16*1024*1024))' }, result => {
    assert.equal(result.status, 'resource_exceeded', JSON.stringify(result));
    assert.equal(result.oomKilled, true); assert.equal(result.exitCode, 137);
  });
  await check('filesystem, network, UID, devices and secret isolation', { language: 'python', source: `
import os,socket,errno
assert os.getuid() == 65532
assert not os.path.exists('/var/run/docker.sock')
assert not os.path.exists('/home/u26kris05')
assert not any(name.startswith('nvidia') for name in os.listdir('/dev'))
assert not any(key in os.environ for key in ['JWT_SECRET','REDIS_URL','MONGODB_URL','OPENAI_API_KEY'])
try:
    open('/root-write-probe','w')
    raise AssertionError('root filesystem writable')
except OSError as error:
    assert error.errno in [errno.EROFS,errno.EACCES]
connection=socket.socket()
connection.settimeout(0.2)
try:
    connection.connect(('198.51.100.1',9))
    raise AssertionError('outbound network available')
except OSError as error:
    assert error.errno in [errno.ENETUNREACH,errno.EHOSTUNREACH]
finally:
    connection.close()
print('isolated')
` }, success('isolated\n'));
  await check('process limit', { language: 'python', source: `
import subprocess
children=[]
try:
    for i in range(40): children.append(subprocess.Popen(['sleep','10']))
    raise AssertionError('process limit not enforced')
except BlockingIOError:
    print('limited')
finally:
    for child in children: child.kill()
    for child in children: child.wait()
` }, success('limited\n'));
  const cancellation = new AbortController();
  const cancelTimer = setTimeout(() => cancellation.abort(), 1000);
  try {
    await check('active cancellation', { language: 'python', source: 'print("started",flush=True)\nwhile True: pass' }, result => {
      assert.equal(result.status, 'cancelled'); assert.equal(result.stdout, 'started\n');
    }, {}, cancellation.signal);
  } finally { clearTimeout(cancelTimer); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
