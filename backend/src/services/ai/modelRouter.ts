import { AiModel } from './types';

export type AiTaskType =
  | 'general-chat'
  | 'coding'
  | 'reasoning'
  | 'document-analysis'
  | 'rag'
  | 'repository-analysis'
  | 'structured-extraction'
  | 'workflow';

export interface RouterGpuStatus {
  available: boolean;
  freeVramMiB?: number;
  totalVramMiB?: number;
}

export interface ModelRoutingRequest {
  provider: string;
  models: AiModel[];
  task: AiTaskType;
  preferredModel?: string;
  defaultModel?: string;
  gpu?: RouterGpuStatus;
}

export interface ModelRoutingDecision {
  provider: string;
  model: string;
  task: AiTaskType;
  reasons: string[];
  evaluatedModels: number;
  score: number;
}

export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRoutingError';
  }
}

const taskPatterns: Record<AiTaskType, RegExp[]> = {
  'general-chat': [/chat/i, /instruct/i],
  coding: [/code/i, /coder/i, /starcoder/i, /codestral/i, /devstral/i],
  reasoning: [/reason/i, /deepseek-r/i, /\br1\b/i, /thinking/i],
  'document-analysis': [/instruct/i, /long/i, /document/i],
  rag: [/instruct/i, /long/i, /rag/i],
  'repository-analysis': [/code/i, /coder/i, /long/i],
  'structured-extraction': [/instruct/i, /json/i, /extract/i],
  workflow: [/instruct/i, /tool/i, /function/i],
};

function modelSizeMiB(model: AiModel): number | undefined {
  return typeof model.sizeBytes === 'number' ? model.sizeBytes / (1024 * 1024) : undefined;
}

export function routeModel(request: ModelRoutingRequest): ModelRoutingDecision {
  const candidates = request.models.filter((model) => model.capabilities?.chat !== false);
  if (!candidates.length) {
    throw new ModelRoutingError(`Provider '${request.provider}' reported no chat-capable models. No provider fallback was attempted.`);
  }

  const preferred = request.preferredModel
    ? candidates.find((model) => model.id === request.preferredModel || model.name === request.preferredModel)
    : undefined;
  if (request.preferredModel && !preferred) {
    throw new ModelRoutingError(
      `Preferred model '${request.preferredModel}' was not reported by provider '${request.provider}'. No model or provider fallback was attempted.`
    );
  }
  if (preferred) {
    return {
      provider: request.provider,
      model: preferred.id,
      task: request.task,
      reasons: [`Selected the explicit user preference '${preferred.id}'.`],
      evaluatedModels: candidates.length,
      score: 1000,
    };
  }

  const scored = candidates.map((model) => {
    let score = 0;
    const reasons: string[] = [];
    const searchable = `${model.id} ${model.name}`;
    if (model.id === request.defaultModel || model.name === request.defaultModel) {
      score += 25;
      reasons.push('Matches the configured default model.');
    }
    const patternMatches = taskPatterns[request.task].filter((pattern) => pattern.test(searchable)).length;
    if (patternMatches) {
      score += patternMatches * 30;
      reasons.push(`Model metadata matches the ${request.task} task.`);
    }
    if (typeof model.contextWindow === 'number') {
      const contextPoints = Math.min(30, Math.floor(model.contextWindow / 8192) * 5);
      score += contextPoints;
      if (contextPoints) reasons.push(`Context window is ${model.contextWindow.toLocaleString()} tokens.`);
    }
    if (request.task === 'structured-extraction' && model.capabilities?.structuredOutput) {
      score += 35;
      reasons.push('Provider metadata reports structured-output support.');
    }
    if (request.task === 'workflow' && model.capabilities?.tools) {
      score += 25;
      reasons.push('Provider metadata reports tool support.');
    }

    const sizeMiB = modelSizeMiB(model);
    if (request.gpu?.available && request.gpu.freeVramMiB && sizeMiB) {
      const conservativeBudget = request.gpu.freeVramMiB * 0.85;
      if (sizeMiB <= conservativeBudget) {
        score += 20;
        reasons.push('Model size fits the conservative free-VRAM budget.');
      } else {
        score -= 200;
        reasons.push('Model size exceeds the conservative free-VRAM budget.');
      }
    }
    if (!reasons.length) reasons.push('Selected from provider-reported chat-capable models.');
    return { model, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
  const selected = scored[0];
  return {
    provider: request.provider,
    model: selected.model.id,
    task: request.task,
    reasons: selected.reasons,
    evaluatedModels: candidates.length,
    score: selected.score,
  };
}
