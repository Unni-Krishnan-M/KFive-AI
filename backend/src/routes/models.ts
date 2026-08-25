import { Request, Response, Router } from 'express';
import { getEnvironment } from '@/config/environment';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { AiProviderClient, getAiProvider } from '@/services/aiProvider';
import { AiProviderError } from '@/services/ai/errors';
import { AiTaskType, ModelRoutingError, routeModel } from '@/services/ai/modelRouter';
import { getGpuStatus, GpuStatus } from '@/services/gpuStatus';
import {
  InMemoryModelDeletionConfirmationStore,
  ModelDeletionConfirmationStore,
  ModelManagementError,
  validateModelName,
} from '@/services/modelManagement';

const deletionConfirmations = new InMemoryModelDeletionConfirmationStore();
const TASKS: readonly AiTaskType[] = [
  'general-chat', 'coding', 'reasoning', 'document-analysis', 'rag',
  'repository-analysis', 'structured-extraction', 'workflow',
];

interface ProviderMetadata {
  id: string;
  capabilities: AiProviderClient['capabilities'];
  management: { pull: boolean; delete: boolean };
  modelScope: 'installed' | 'available';
}

function providerMetadata(provider: AiProviderClient): ProviderMetadata {
  return {
    id: provider.id,
    capabilities: provider.capabilities,
    management: {
      pull: provider.id === 'ollama' && provider.capabilities.modelPull === true && Boolean(provider.pullModel),
      delete: provider.id === 'ollama' && provider.capabilities.modelDelete === true && Boolean(provider.deleteModel),
    },
    modelScope: provider.id === 'ollama' ? 'installed' : 'available',
  };
}

function managementError(res: Response, error: unknown): boolean {
  if (error instanceof ModelManagementError) {
    res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
    return true;
  }
  if (error instanceof ModelRoutingError) {
    res.status(409).json({ success: false, error: { code: 'MODEL_ROUTING_FAILED', message: error.message } });
    return true;
  }
  if (error instanceof AiProviderError) {
    const status = error.code === 'UNSUPPORTED_CAPABILITY' ? 501 : error.code === 'PROVIDER_UNAVAILABLE' ? 503 : 502;
    res.status(status).json({
      success: false,
      error: { code: error.code, provider: error.provider, retryable: error.retryable, message: error.message },
    });
    return true;
  }
  return false;
}

function unsupportedOperation(provider: AiProviderClient, operation: 'pull' | 'delete'): ModelManagementError {
  return new ModelManagementError(
    `Model ${operation} is unavailable for the configured '${provider.id}' provider. No provider fallback was attempted.`,
    'UNSUPPORTED_MODEL_OPERATION',
    501
  );
}

function requireTask(value: unknown): AiTaskType {
  if (typeof value !== 'string' || !TASKS.includes(value as AiTaskType)) {
    throw new ModelManagementError(`task must be one of: ${TASKS.join(', ')}.`, 'INVALID_TASK_TYPE', 400);
  }
  return value as AiTaskType;
}

export function createModelsRouter(
  resolveProvider: () => AiProviderClient = getAiProvider,
  confirmations: ModelDeletionConfirmationStore = deletionConfirmations,
  probeGpu: () => Promise<GpuStatus> = getGpuStatus,
  defaultModel: string = getEnvironment().aiDefaultModel
): Router {
  const router = Router();

  const listHandler = asyncHandler(async (_req, res) => {
    const provider = resolveProvider();
    try {
      const models = await provider.listModels();
      res.json({ success: true, data: { provider: providerMetadata(provider), models } });
    } catch (error) {
      if (!managementError(res, error)) throw error;
    }
  });

  router.get('/', listHandler);
  router.get('/catalog', listHandler);
  router.get('/installed', listHandler);

  router.get('/metadata', asyncHandler(async (req, res) => {
    try {
      const modelName = validateModelName(req.query.model);
      const provider = resolveProvider();
      const models = await provider.listModels();
      const model = models.find((candidate) => candidate.id === modelName || candidate.name === modelName);
      if (!model) {
        throw new ModelManagementError(
          `Model '${modelName}' was not reported by the configured '${provider.id}' provider.`,
          'MODEL_NOT_FOUND',
          404
        );
      }
      res.json({ success: true, data: { provider: providerMetadata(provider), model } });
    } catch (error) {
      if (!managementError(res, error)) throw error;
    }
  }));

  router.post('/route', asyncHandler(async (req, res) => {
    try {
      const task = requireTask(req.body?.task);
      const preferredModel = req.body?.preferredModel === undefined
        ? undefined
        : validateModelName(req.body.preferredModel);
      const provider = resolveProvider();
      const [models, gpu] = await Promise.all([provider.listModels(), probeGpu()]);
      const decision = routeModel({
        provider: provider.id,
        models,
        task,
        preferredModel,
        defaultModel,
        gpu: {
          available: gpu.available,
          freeVramMiB: gpu.summary?.freeVramMiB,
          totalVramMiB: gpu.summary?.totalVramMiB,
        },
      });
      res.json({ success: true, data: decision });
    } catch (error) {
      if (!managementError(res, error)) throw error;
    }
  }));

  router.post('/pull', async (req: Request, res: Response, next) => {
    let responseStarted = false;
    try {
      const model = validateModelName(req.body?.model);
      const provider = resolveProvider();
      const metadata = providerMetadata(provider);
      if (!metadata.management.pull || !provider.pullModel) throw unsupportedOperation(provider, 'pull');

      const controller = new AbortController();
      const abort = (): void => controller.abort();
      req.once('aborted', abort);
      res.once('close', abort);
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.flushHeaders();
      responseStarted = true;
      try {
        await provider.pullModel(model, (progress) => {
          if (!res.writableEnded) res.write(`${JSON.stringify({ type: 'progress', data: progress })}\n`);
        }, { signal: controller.signal });
        if (!res.writableEnded) {
          res.write(`${JSON.stringify({ type: 'done', data: { provider: provider.id, model } })}\n`);
          res.end();
        }
      } finally {
        req.off('aborted', abort);
        res.off('close', abort);
      }
    } catch (error) {
      if (responseStarted) {
        const safeError = error instanceof AiProviderError
          ? { code: error.code, provider: error.provider, retryable: error.retryable, message: error.message }
          : { code: 'MODEL_PULL_FAILED', message: 'The model pull failed.' };
        if (!res.writableEnded) {
          res.write(`${JSON.stringify({ type: 'error', error: safeError })}\n`);
          res.end();
        }
      } else if (!managementError(res, error)) {
        next(error);
      }
    }
  });

  router.post('/delete-confirmation', asyncHandler(async (req, res) => {
    try {
      const model = validateModelName(req.body?.model);
      const provider = resolveProvider();
      const metadata = providerMetadata(provider);
      if (!metadata.management.delete || !provider.deleteModel) throw unsupportedOperation(provider, 'delete');
      const models = await provider.listModels();
      if (!models.some((candidate) => candidate.id === model || candidate.name === model)) {
        throw new ModelManagementError(
          `Model '${model}' is not installed on the configured provider.`,
          'MODEL_NOT_FOUND',
          404
        );
      }
      const confirmation = confirmations.issue({ userId: getAuthenticatedUserId(req), provider: provider.id, model });
      res.json({ success: true, data: { provider: provider.id, model, ...confirmation } });
    } catch (error) {
      if (!managementError(res, error)) throw error;
    }
  }));

  router.delete('/', asyncHandler(async (req, res) => {
    try {
      const model = validateModelName(req.body?.model);
      const provider = resolveProvider();
      const metadata = providerMetadata(provider);
      if (!metadata.management.delete || !provider.deleteModel) throw unsupportedOperation(provider, 'delete');
      confirmations.consume(req.body?.confirmationToken, {
        userId: getAuthenticatedUserId(req),
        provider: provider.id,
        model,
      });
      await provider.deleteModel(model);
      res.json({ success: true, data: { provider: provider.id, model, deleted: true } });
    } catch (error) {
      if (!managementError(res, error)) throw error;
    }
  }));

  return router;
}

export default createModelsRouter();
