import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFreshHeartbeat, HeartbeatClient } from '../src/healthcheck';

class FakeHeartbeatClient implements HeartbeatClient {
  isOpen = false;

  constructor(private readonly value: string | null) {}

  on(): unknown {
    return undefined;
  }

  async connect(): Promise<void> {
    this.isOpen = true;
  }

  async get(): Promise<string | null> {
    return this.value;
  }

  async quit(): Promise<void> {
    this.isOpen = false;
  }
}

test('accepts a fresh decimal millisecond heartbeat', async () => {
  await assertFreshHeartbeat(new FakeHeartbeatClient('1700000000000'), 1700000005000);
});

test('rejects missing, malformed, stale, and implausibly future heartbeats', async () => {
  const invalid = [null, 'not-a-number', '1699999984999', '1700000005001'];
  for (const value of invalid) {
    await assert.rejects(
      assertFreshHeartbeat(new FakeHeartbeatClient(value), 1700000000000),
      /heartbeat is missing, malformed, or stale/
    );
  }
});
