export type DeploymentMode = 'local' | 'hybrid' | 'remote' | 'unknown';
export type ServiceLocation = 'local' | 'remote' | 'disabled' | 'unknown';
export type ConnectionState = 'online' | 'offline' | 'degraded' | 'disabled' | 'unknown';

export interface RuntimeService {
  id: string;
  name: string;
  url?: string;
  location: ServiceLocation;
  status: ConnectionState;
  configured: boolean;
  restartRequired: boolean;
  message?: string;
}

export interface RuntimeProvider {
  id: string;
  name: string;
  url?: string;
  location: ServiceLocation;
  status: ConnectionState;
  configured: boolean;
  model?: string;
  restartRequired: boolean;
  liveSwitchSupported: boolean;
  message?: string;
}

export interface RuntimeSettings {
  mode: DeploymentMode;
  provider: RuntimeProvider;
  services: RuntimeService[];
  missingDependencies: string[];
  restartRequired: string[];
  note?: string;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const firstString = (record: UnknownRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return undefined;
};

const titleCase = (value: string): string => value
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function unwrapApiData(payload: unknown): unknown {
  const envelope = asRecord(payload);
  return envelope && 'data' in envelope ? envelope.data : payload;
}

export function sanitizeServiceUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw
      .replace(/(\w+:\/\/)[^/@\s]+@/, '$1')
      .replace(/[?#].*$/, '');
  }
}

function normalizeMode(value: unknown): DeploymentMode {
  const mode = asString(value)?.toLowerCase();
  return mode === 'local' || mode === 'hybrid' || mode === 'remote' ? mode : 'unknown';
}

function normalizeStatus(value: unknown, configured: boolean): ConnectionState {
  if (!configured) return 'disabled';
  const status = asString(value)?.toLowerCase();
  if (status === 'ok' || status === 'healthy' || status === 'ready' || status === 'connected' || status === 'online') return 'online';
  if (status === 'error' || status === 'failed' || status === 'unhealthy' || status === 'unavailable' || status === 'offline') return 'offline';
  if (status === 'degraded' || status === 'partial') return 'degraded';
  if (status === 'disabled' || status === 'not-configured' || status === 'unconfigured') return 'disabled';
  return 'unknown';
}

function inferLocation(value: unknown, url: string | undefined): ServiceLocation {
  const location = asString(value)?.toLowerCase();
  if (location === 'local' || location === 'host' || location === 'container') return 'local';
  if (location === 'remote' || location === 'cloud') return 'remote';
  if (location === 'disabled') return 'disabled';
  if (!url) return 'unknown';

  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|mongodb|redis|chromadb)([:/]|$)/i.test(url)
    ? 'local'
    : 'remote';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    const record = asRecord(item);
    return record ? firstString(record, ['message', 'name', 'dependency', 'key']) : undefined;
  }).filter((item): item is string => Boolean(item));
}

function normalizeService(id: string, value: unknown): RuntimeService {
  const record = asRecord(value) ?? {};
  const url = sanitizeServiceUrl(firstString(record, ['url', 'baseUrl', 'endpoint']));
  const configured = asBoolean(record.configured, Boolean(url));
  return {
    id,
    name: firstString(record, ['name', 'label']) ?? titleCase(id),
    url,
    configured,
    location: configured ? inferLocation(record.location ?? record.scope ?? record.type, url) : 'disabled',
    status: normalizeStatus(record.status ?? record.health, configured),
    restartRequired: asBoolean(record.restartRequired, true),
    message: firstString(record, ['message', 'error', 'reason']),
  };
}

function normalizeServices(value: unknown): RuntimeService[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const record = asRecord(item) ?? {};
      const id = firstString(record, ['id', 'key', 'name', 'service']) ?? `service-${index + 1}`;
      return normalizeService(id.toLowerCase().replace(/\s+/g, '-'), record);
    });
  }

  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).map(([id, service]) => normalizeService(id, service));
}

function normalizeProvider(value: unknown, root: UnknownRecord): RuntimeProvider {
  const record = asRecord(value) ?? {};
  const providerName = firstString(record, ['id', 'type', 'provider', 'name'])
    ?? firstString(root, ['aiProvider', 'providerName'])
    ?? (typeof value === 'string' ? value : undefined)
    ?? 'unknown';
  const url = sanitizeServiceUrl(firstString(record, ['url', 'baseUrl', 'endpoint']));
  const configured = asBoolean(record.configured, providerName !== 'unknown');

  return {
    id: providerName.toLowerCase(),
    name: firstString(record, ['displayName', 'label', 'name']) ?? titleCase(providerName),
    url,
    configured,
    location: configured ? inferLocation(record.location ?? record.scope ?? record.type, url) : 'disabled',
    status: normalizeStatus(record.status ?? record.health, configured),
    model: firstString(record, ['model', 'selectedModel', 'defaultModel']),
    restartRequired: asBoolean(record.restartRequired, false),
    liveSwitchSupported: asBoolean(record.liveSwitchSupported, false),
    message: firstString(record, ['message', 'error', 'reason']),
  };
}

export function normalizeRuntimeSettings(payload: unknown): RuntimeSettings {
  const root = asRecord(unwrapApiData(payload)) ?? {};
  const mode = normalizeMode(root.mode ?? root.kfiveMode ?? root.deploymentMode);
  const services = normalizeServices(root.services ?? root.serviceLocations ?? root.dependencies);
  const provider = normalizeProvider(root.provider ?? root.ai ?? root.aiProvider, root);
  const missingDependencies = [
    ...stringList(root.missingDependencies),
    ...stringList(root.missingConfiguration),
    ...stringList(root.configurationErrors),
  ].filter((value, index, items) => items.indexOf(value) === index);
  const restartRequired = stringList(root.restartRequiredFields ?? root.restartRequired ?? root.restartRequiredSettings);

  return {
    mode,
    provider,
    services,
    missingDependencies,
    restartRequired,
    note: firstString(root, ['note', 'message']),
  };
}

export function normalizeModels(payload: unknown): string[] {
  const value = unwrapApiData(payload);
  const record = asRecord(value);
  const models = Array.isArray(value) ? value : record?.models;
  if (!Array.isArray(models)) return [];

  return models.map((model) => {
    if (typeof model === 'string') return model;
    const modelRecord = asRecord(model);
    return modelRecord ? firstString(modelRecord, ['name', 'model', 'id']) : undefined;
  }).filter((model): model is string => Boolean(model));
}

export function readableApiError(error: unknown, fallback: string): string {
  const candidate = asRecord(error);
  const response = asRecord(candidate?.response);
  const responseData = asRecord(response?.data);
  const nestedData = asRecord(responseData?.data);
  const nestedError = asRecord(responseData?.error);
  const directError = asString(responseData?.error);
  const nestedErrorMessage = nestedError ? firstString(nestedError, ['message', 'error']) : undefined;
  return nestedErrorMessage
    ?? directError
    ?? firstString(responseData ?? {}, ['message'])
    ?? firstString(nestedData ?? {}, ['message', 'error'])
    ?? firstString(candidate ?? {}, ['message'])
    ?? fallback;
}
