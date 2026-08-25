import { createClient } from 'redis';
import { redisClientOptions, RUNNER_HEARTBEAT_KEY } from './coordinator';
import { parseRedisUrl } from './redisConfig';

const DEFAULT_MAX_HEARTBEAT_AGE_MS = 15_000;
const MAX_FUTURE_SKEW_MS = 5_000;

export interface HeartbeatClient {
  readonly isOpen: boolean;
  on(event: 'error', handler: () => void): unknown;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

export async function assertFreshHeartbeat(
  client: HeartbeatClient,
  nowMs: number = Date.now(),
  maxAgeMs: number = DEFAULT_MAX_HEARTBEAT_AGE_MS
): Promise<void> {
  await client.connect();
  const raw = await client.get(RUNNER_HEARTBEAT_KEY);
  const timestampMs = raw === null ? Number.NaN : Number(raw);
  const ageMs = nowMs - timestampMs;
  if (!Number.isSafeInteger(timestampMs) || ageMs > maxAgeMs || ageMs < -MAX_FUTURE_SKEW_MS) {
    throw new Error('Code-runner heartbeat is missing, malformed, or stale.');
  }
}

async function main(): Promise<void> {
  const config = parseRedisUrl(process.env.REDIS_URL);
  const client = createClient(redisClientOptions(config)) as unknown as HeartbeatClient;
  client.on('error', () => undefined);
  try {
    await assertFreshHeartbeat(client);
  } finally {
    if (client.isOpen) await client.quit().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().catch(() => {
    // Never print Redis connection details or errors that could contain credentials.
    process.exitCode = 1;
  });
}
