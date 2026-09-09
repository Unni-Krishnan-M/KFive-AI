import { randomUUID } from 'crypto';
import {
  BENCHMARK_RESOURCE_FENCE_KEY,
  BENCHMARK_RESOURCE_LEASE_KEY,
} from './benchmarkQueue';

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export interface LeaseRedis {
  incr(key: string): Promise<number>;
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface BenchmarkLeaseHandle {
  fence: number;
  owner: string;
  signal: AbortSignal;
  lost: Promise<void>;
  release(): Promise<void>;
}

export class BenchmarkResourceLease {
  constructor(
    private readonly redis: LeaseRedis,
    private readonly ttlMs = 30_000,
    private readonly renewEveryMs = 10_000
  ) {}

  async tryAcquire(instanceId: string): Promise<BenchmarkLeaseHandle | undefined> {
    const fence = await this.redis.incr(BENCHMARK_RESOURCE_FENCE_KEY);
    const owner = `${fence}-${instanceId}-${randomUUID()}`;
    const acquired = await this.redis.set(BENCHMARK_RESOURCE_LEASE_KEY, owner, { NX: true, PX: this.ttlMs });
    if (acquired !== 'OK') return undefined;

    const controller = new AbortController();
    let resolveLost!: () => void;
    const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
    let released = false;
    let renewing = false;
    const markLost = (): void => {
      if (released || controller.signal.aborted) return;
      controller.abort();
      resolveLost();
    };
    const timer = setInterval(() => {
      if (renewing || released) return;
      renewing = true;
      void this.redis.eval(RENEW_SCRIPT, {
        keys: [BENCHMARK_RESOURCE_LEASE_KEY], arguments: [owner, String(this.ttlMs)],
      }).then((result) => { if (Number(result) !== 1) markLost(); })
        .catch(markLost)
        .finally(() => { renewing = false; });
    }, this.renewEveryMs);
    timer.unref();

    return {
      fence,
      owner,
      signal: controller.signal,
      lost,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          await this.redis.eval(RELEASE_SCRIPT, {
            keys: [BENCHMARK_RESOURCE_LEASE_KEY], arguments: [owner],
          });
        } finally {
          if (!controller.signal.aborted) controller.abort();
        }
      },
    };
  }
}
