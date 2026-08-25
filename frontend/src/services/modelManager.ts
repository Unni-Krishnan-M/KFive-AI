import { unwrapApiData } from './runtimeSettings';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  sizeBytes?: number;
  modifiedAt?: string;
  contextWindow?: number;
  capabilities: string[];
}

export interface ModelCatalog {
  provider: string;
  modelScope: 'installed' | 'available' | 'unknown';
  canPull: boolean;
  canDelete: boolean;
  models: ModelInfo[];
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

export function normalizeModelCatalog(payload: unknown): ModelCatalog {
  const root = record(unwrapApiData(payload));
  const provider = record(root.provider);
  const management = record(provider.management);
  const rawModels = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : [];
  return {
    provider: typeof provider.id === 'string' ? provider.id : typeof root.provider === 'string' ? root.provider : 'unknown',
    modelScope: provider.modelScope === 'installed' || provider.modelScope === 'available' ? provider.modelScope : 'unknown',
    canPull: management.pull === true,
    canDelete: management.delete === true,
    models: rawModels.map((item) => {
      const model = record(item);
      const id = typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : '';
      const capabilities = record(model.capabilities);
      return {
        id,
        name: typeof model.name === 'string' ? model.name : id,
        provider: typeof model.provider === 'string' ? model.provider : typeof provider.id === 'string' ? provider.id : 'unknown',
        sizeBytes: typeof model.sizeBytes === 'number' ? model.sizeBytes : typeof model.size === 'number' ? model.size : undefined,
        modifiedAt: typeof model.modifiedAt === 'string' ? model.modifiedAt : typeof model.modified_at === 'string' ? model.modified_at : undefined,
        contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
        capabilities: Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name),
      };
    }).filter((model) => Boolean(model.id)),
  };
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return 'Size unavailable';
  const gib = bytes / (1024 ** 3);
  return gib >= 0.1 ? `${gib.toFixed(1)} GiB` : `${(bytes / (1024 ** 2)).toFixed(0)} MiB`;
}
