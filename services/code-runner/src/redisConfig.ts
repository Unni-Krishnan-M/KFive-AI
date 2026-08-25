export interface ParsedRedisConfig {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
}

export function parseRedisUrl(raw: string | undefined): ParsedRedisConfig {
  if (!raw) throw new Error('REDIS_URL is required for the code-runner worker.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('REDIS_URL is not a valid Redis URL.');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://.');
  }
  let username: string | undefined;
  let password: string | undefined;
  try {
    username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  } catch {
    throw new Error('REDIS_URL contains invalid credential encoding.');
  }
  const databaseText = parsed.pathname.length > 1 ? parsed.pathname.slice(1) : '0';
  if (!/^\d+$/.test(databaseText)) throw new Error('REDIS_URL database must be a non-negative integer.');
  const db = Number(databaseText);
  if (!Number.isSafeInteger(db) || db > 255) throw new Error('REDIS_URL database is outside the supported range.');
  const port = parsed.port ? Number(parsed.port) : 6379;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('REDIS_URL port is outside the supported range.');
  }
  return {
    host: parsed.hostname,
    port,
    db,
    username,
    password,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
