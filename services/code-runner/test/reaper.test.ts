import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DockerCommandAdapter,
  DockerCommandOptions,
  DockerCommandResult,
} from '../src/dockerCli';
import { StaleCodeRunReaper } from '../src/reaper';

const STALE_RUNNING = '1111111111111111111111111111111111111111111111111111111111111111';
const RECENT_RUNNING = '2222222222222222222222222222222222222222222222222222222222222222';
const STALE_UNLABELED = '3333333333333333333333333333333333333333333333333333333333333333';

interface RecordedCall {
  args: readonly string[];
  options: DockerCommandOptions;
}

function result(stdout = '', exitCode = 0): DockerCommandResult {
  return { stdout, stderr: '', exitCode, signal: null };
}

function inspection(created: string, running: boolean, labeled = true): string {
  return JSON.stringify({
    Created: created,
    Config: { Labels: labeled ? { 'com.kfive.code-run': 'true' } : {} },
    State: { Running: running },
  });
}

class FakeDocker implements DockerCommandAdapter {
  readonly calls: RecordedCall[] = [];

  async run(args: readonly string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    this.calls.push({ args: [...args], options });
    if (args[0] === 'ps') {
      return result(`${STALE_RUNNING}\n${RECENT_RUNNING}\n${STALE_UNLABELED}\nnot-an-id\n`);
    }
    if (args[0] === 'inspect' && args.at(-1) === STALE_RUNNING) {
      return result(inspection('2023-11-14T22:10:00.000Z', true));
    }
    if (args[0] === 'inspect' && args.at(-1) === RECENT_RUNNING) {
      return result(inspection('2023-11-14T22:13:10.000Z', true));
    }
    if (args[0] === 'inspect' && args.at(-1) === STALE_UNLABELED) {
      return result(inspection('2023-11-14T22:10:00.000Z', false, false));
    }
    return result();
  }
}

test('reaps only stale labeled containers and uses bounded structured Docker arguments', async () => {
  const docker = new FakeDocker();
  const events: string[] = [];
  const reaper = new StaleCodeRunReaper(docker, {
    now: () => 1_700_000_000_000,
    staleAfterMs: 120_000,
    onError: (event) => events.push(event),
  });

  const summary = await reaper.reap();

  assert.deepEqual(summary, { scanned: 3, removed: 1 });
  assert.deepEqual(docker.calls[0].args, [
    'ps', '--all', '--no-trunc', '--filter', 'label=com.kfive.code-run=true', '--format', '{{.ID}}',
  ]);
  assert.deepEqual(docker.calls[0].options, { maxOutputBytes: 64 * 1024, timeoutMs: 5_000 });
  assert.ok(docker.calls.some((call) => call.args[0] === 'kill' && call.args[1] === STALE_RUNNING));
  assert.ok(docker.calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === STALE_RUNNING));
  assert.equal(docker.calls.some((call) => call.args[0] === 'kill' && call.args[1] === RECENT_RUNNING), false);
  assert.equal(docker.calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === RECENT_RUNNING), false);
  assert.equal(docker.calls.some((call) => call.args.at(-1) === STALE_UNLABELED && call.args[0] === 'rm'), false);
  assert.deepEqual(events, ['stale-container-metadata-invalid', 'stale-container-id-invalid']);
});

test('cleanup failures emit safe fixed events and do not stop other labeled cleanup', async () => {
  const first = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const second = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const calls: string[][] = [];
  const docker: DockerCommandAdapter = {
    async run(args): Promise<DockerCommandResult> {
      calls.push([...args]);
      if (args[0] === 'ps') return result(`${first}\n${second}\n`);
      if (args[0] === 'inspect') return result(inspection('2023-11-14T22:10:00.000Z', false));
      if (args[0] === 'rm' && args.at(-1) === first) throw new Error('sensitive daemon detail');
      return result();
    },
  };
  const events: string[] = [];
  const reaper = new StaleCodeRunReaper(docker, {
    now: () => 1_700_000_000_000,
    onError: (event) => events.push(event),
  });

  const summary = await reaper.reap();

  assert.deepEqual(summary, { scanned: 2, removed: 1 });
  assert.deepEqual(events, ['stale-container-remove-failed']);
  assert.ok(calls.some((args) => args[0] === 'rm' && args.at(-1) === second));
  assert.equal(events.some((event) => event.includes('sensitive')), false);
});
