import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ReaperLoop } from '../src/reaperLoop';

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), 'expected scheduled sweep');
}

test('repeats sweeps without overlapping and drains on shutdown', async () => {
  let calls = 0;
  let release!: () => void;
  const loop = new ReaperLoop(async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
  }, () => undefined, 5);
  loop.start();
  loop.start();
  await until(() => calls === 1);
  await delay(20);
  assert.equal(calls, 1);
  release();
  await until(() => calls >= 2);
  await loop.stop();
  const stopped = calls;
  await delay(20);
  assert.equal(calls, stopped);
});

test('failed sweeps are reported safely and retried', async () => {
  let calls = 0;
  const events: string[] = [];
  const loop = new ReaperLoop(async () => {
    calls++;
    if (calls === 1) throw new Error('secret');
  }, event => events.push(event), 5);
  loop.start();
  await until(() => calls >= 2);
  await loop.stop();
  assert.deepEqual(events, ['stale-container-sweep-failed']);
});

test('stop waits for an active sweep without scheduling another', async () => {
  let release!: () => void;
  let done = false;
  const loop = new ReaperLoop(() => new Promise<void>(resolve => { release = resolve; }), () => undefined, 5);
  loop.start();
  await until(() => !!release);
  const stopping = loop.stop().then(() => { done = true; });
  await delay(10);
  assert.equal(done, false);
  release();
  await stopping;
  assert.equal(done, true);
});
