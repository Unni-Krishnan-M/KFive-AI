import assert from 'node:assert/strict';
import test from 'node:test';
import { createArguments } from '../src/executor';
import { getRuntime, sourceArguments } from '../src/runtimeRegistry';
import { DEFAULT_RUNNER_LIMITS } from '../src/types';

test('source stays bounded data after a fixed bootstrap, not shell syntax or runtime flags', () => {
  const source = '--inspect; $(touch /tmp/never)\n' + '😀'.repeat(60_000);
  const chunks = sourceArguments(source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 32768 && /^[A-Za-z0-9+/=]+$/.test(chunk)));
  assert.equal(Buffer.from(chunks.join(''), 'base64').toString('utf8'), source);
  for (const language of ['python', 'javascript']) {
    const runtime = getRuntime(language);
    const args = createArguments(runtime, 'source-test', DEFAULT_RUNNER_LIMITS, source);
    assert.deepEqual(args.slice(args.indexOf(runtime.image) + 1), [...runtime.command, ...chunks]);
    assert.ok(args.includes('--read-only'));
    assert.equal(args.includes('--mount'), false);
    assert.equal(args.includes('--volume'), false);
    assert.equal(args.includes('sh'), false);
  }
});
