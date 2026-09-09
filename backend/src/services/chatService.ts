import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { Conversation, ConversationGenerationStatus, ConversationMessage } from '@/models/Conversation';
import { AiMessage, AiProviderClient, AiStreamEvent, AiUsage } from '@/services/ai/types';
import { AiProviderError } from '@/services/ai/errors';
import { getAiProvider } from '@/services/aiProvider';
import { ProjectService, projectService } from '@/services/projectService';

export const CHAT_LIMITS = Object.freeze({
  promptCharacters: 4_000,
  promptBytes: 16 * 1024,
  outputBytes: 256 * 1024,
  contextBytes: 1024 * 1024,
  modelBytes: 200,
  messageRetention: 64,
  timeoutMs: 120_000,
});

export type ChatErrorCode =
  | 'INVALID_CHAT_INPUT'
  | 'CHAT_NOT_FOUND'
  | 'CHAT_BUSY'
  | 'CHAT_LIMIT_REACHED'
  | 'CHAT_CONFLICT'
  | 'CHAT_STORAGE_UNAVAILABLE'
  | 'CHAT_PROVIDER_UNAVAILABLE'
  | 'CHAT_TIMEOUT'
  | 'CHAT_GENERATION_FAILED'
  | 'CHAT_OUTPUT_LIMIT'
  | 'CHAT_CANCELLED'
  | 'CHAT_INTERRUPTED';

export class ChatError extends Error {
  readonly isOperational = true;

  constructor(message: string, readonly code: ChatErrorCode, readonly statusCode: number) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface ChatGenerationState {
  requestId: string;
  status: ConversationGenerationStatus;
  userMessageId: unknown;
  provider?: string;
  model?: string;
  outputBytes: number;
  usage?: AiUsage;
  error?: { code: string; message: string };
  startedAt: Date;
  deadlineAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

export interface ChatConversationRecord {
  _id: unknown;
  userId: unknown;
  projectId?: unknown;
  messages: Array<ConversationMessage & { _id?: unknown }>;
  settings?: { model?: string; temperature?: number };
  generation?: ChatGenerationState;
  metadata?: { totalTokens?: number; messageCount?: number; lastMessageAt?: Date };
  [key: string]: unknown;
}

export interface ChatTerminalData {
  status: Exclude<ConversationGenerationStatus, 'running'>;
  content: string;
  provider: string;
  model: string;
  outputBytes: number;
  usage?: AiUsage;
  error?: { code: string; message: string };
  completedAt: Date;
  durationMs: number;
  timeToFirstTokenMs?: number;
}

export interface ChatRepository {
  findByOwnerAndId(ownerId: string, conversationId: string): Promise<ChatConversationRecord | null>;
  begin(
    ownerId: string,
    conversationId: string,
    message: ConversationMessage & { _id: unknown },
    generation: ChatGenerationState
  ): Promise<ChatConversationRecord | null>;
  markStarted(
    ownerId: string,
    conversationId: string,
    requestId: string,
    provider: string,
    model: string,
    timeToFirstTokenMs?: number
  ): Promise<boolean>;
  finish(
    ownerId: string,
    conversationId: string,
    requestId: string,
    terminal: ChatTerminalData
  ): Promise<ChatConversationRecord | null>;
  interruptActive(before: Date, completedAt: Date): Promise<number>;
}

export const mongooseChatRepository: ChatRepository = {
  async findByOwnerAndId(ownerId, conversationId) {
    const result = await Conversation.findOne({ _id: conversationId, userId: ownerId }).lean();
    return result as unknown as ChatConversationRecord | null;
  },

  async begin(ownerId, conversationId, message, generation) {
    return Conversation.findOneAndUpdate(
      {
        _id: conversationId,
        userId: ownerId,
        'generation.status': { $ne: 'running' },
        // Reserve two slots for the durable user and terminal assistant records.
        'metadata.messageCount': { $lt: CHAT_LIMITS.messageRetention - 1 },
      },
      {
        $push: { messages: message },
        $set: { generation, 'metadata.lastMessageAt': message.timestamp },
        $inc: { 'metadata.messageCount': 1 },
      },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<ChatConversationRecord | null>;
  },

  async markStarted(ownerId, conversationId, requestId, provider, model, timeToFirstTokenMs) {
    const result = await Conversation.updateOne(
      { _id: conversationId, userId: ownerId, 'generation.requestId': requestId, 'generation.status': 'running' },
      {
        $set: {
          'generation.provider': provider,
          'generation.model': model,
          ...(timeToFirstTokenMs !== undefined ? { 'generation.timeToFirstTokenMs': timeToFirstTokenMs } : {}),
        },
      },
      { runValidators: true }
    );
    return result.matchedCount === 1;
  },

  async finish(ownerId, conversationId, requestId, terminal) {
    const assistantMessage: ConversationMessage = {
      role: 'assistant',
      content: terminal.content,
      timestamp: terminal.completedAt,
      requestId,
      status: terminal.status,
      provider: terminal.provider,
      model: terminal.model,
      ...(terminal.usage ? { usage: terminal.usage } : {}),
      ...(terminal.error ? { error: terminal.error } : {}),
      durationMs: terminal.durationMs,
      ...(terminal.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: terminal.timeToFirstTokenMs }
        : {}),
    };
    const totalTokens = terminal.usage?.totalTokens
      ?? ((terminal.usage?.inputTokens ?? 0) + (terminal.usage?.outputTokens ?? 0));
    return Conversation.findOneAndUpdate(
      { _id: conversationId, userId: ownerId, 'generation.requestId': requestId, 'generation.status': 'running' },
      {
        $push: { messages: assistantMessage },
        $set: {
          'generation.status': terminal.status,
          'generation.provider': terminal.provider,
          'generation.model': terminal.model,
          'generation.outputBytes': terminal.outputBytes,
          ...(terminal.usage ? { 'generation.usage': terminal.usage } : {}),
          ...(terminal.error ? { 'generation.error': terminal.error } : {}),
          'generation.completedAt': terminal.completedAt,
          'generation.durationMs': terminal.durationMs,
          ...(terminal.timeToFirstTokenMs !== undefined
            ? { 'generation.timeToFirstTokenMs': terminal.timeToFirstTokenMs }
            : {}),
          'metadata.lastMessageAt': terminal.completedAt,
        },
        $inc: { 'metadata.messageCount': 1, 'metadata.totalTokens': totalTokens },
      },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<ChatConversationRecord | null>;
  },

  async interruptActive(before, completedAt) {
    const result = await Conversation.updateMany(
      {
        'generation.status': 'running',
        $or: [
          { 'generation.deadlineAt': { $lt: completedAt } },
          { 'generation.deadlineAt': { $exists: false }, 'generation.startedAt': { $lt: before } },
        ],
      },
      {
        $set: {
          'generation.status': 'interrupted',
          'generation.completedAt': completedAt,
          'generation.error': {
            code: 'CHAT_INTERRUPTED',
            message: 'The chat generation was interrupted before completion.',
          },
        },
      },
      { runValidators: true }
    );
    return result.modifiedCount;
  },
};

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) {
    throw new ChatError(`${label} is invalid.`, 'INVALID_CHAT_INPUT', 400);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unsafeText(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
  });
}

function safeRuntimeLabel(value: unknown, maximumBytes: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const label = value.normalize('NFC').trim();
  return label && Buffer.byteLength(label, 'utf8') <= maximumBytes && !unsafeText(label) ? label : fallback;
}

export function validateChatStreamInput(value: unknown): { message: string; model?: string } {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'message' && key !== 'model')) {
    throw new ChatError('Chat input must contain only message and optional model fields.', 'INVALID_CHAT_INPUT', 400);
  }
  if (typeof value.message !== 'string') {
    throw new ChatError('Chat message is required.', 'INVALID_CHAT_INPUT', 400);
  }
  const message = value.message.normalize('NFC').trim();
  if (!message || [...message].length > CHAT_LIMITS.promptCharacters
    || Buffer.byteLength(message, 'utf8') > CHAT_LIMITS.promptBytes || unsafeText(message)) {
    throw new ChatError(
      'Chat message must contain 1 to 4000 safe characters and no more than 16384 UTF-8 bytes.',
      'INVALID_CHAT_INPUT',
      400
    );
  }
  if (value.model === undefined || value.model === '') return { message };
  const model = safeRuntimeLabel(value.model, CHAT_LIMITS.modelBytes, '');
  if (!model) throw new ChatError('Chat model is invalid.', 'INVALID_CHAT_INPUT', 400);
  return { message, model };
}

function normalizeUsage(value: AiUsage | undefined): AiUsage | undefined {
  if (!value) return undefined;
  const output: AiUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'totalDurationMs', 'loadDurationMs'] as const) {
    const item = value[key];
    if (item !== undefined && Number.isFinite(item) && item >= 0) {
      const maximum = key === 'totalTokens' ? 200_000_000
        : key === 'inputTokens' || key === 'outputTokens' ? 100_000_000 : 86_400_000;
      output[key] = Math.min(Math.floor(item), maximum);
    }
  }
  return Object.keys(output).length ? output : undefined;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function buildProviderMessages(messages: Array<Pick<ConversationMessage, 'role' | 'content'>>): AiMessage[] {
  const selected: AiMessage[] = [];
  let usedBytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const bytes = Buffer.byteLength(message.content, 'utf8');
    if (bytes > CHAT_LIMITS.contextBytes) continue;
    if (usedBytes + bytes > CHAT_LIMITS.contextBytes) break;
    selected.push({ role: message.role, content: message.content });
    usedBytes += bytes;
  }
  return selected.reverse();
}

function publicFailure(error: unknown, active: ActiveGeneration): ChatTerminalData['error'] & {
  status: ChatTerminalData['status'];
} {
  if (active.outputLimit) {
    return { status: 'output_limit', code: 'CHAT_OUTPUT_LIMIT', message: 'The response reached the 262144-byte output limit.' };
  }
  if (active.cancelRequested) {
    return { status: 'cancelled', code: 'CHAT_CANCELLED', message: 'Generation was stopped.' };
  }
  if (active.timedOut || (error instanceof AiProviderError && error.code === 'REQUEST_TIMEOUT')) {
    return { status: 'timed_out', code: 'CHAT_TIMEOUT', message: 'The AI provider request timed out.' };
  }
  if (error instanceof AiProviderError && (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'UNSUPPORTED_CAPABILITY')) {
    return { status: 'failed', code: 'CHAT_PROVIDER_UNAVAILABLE', message: 'The configured AI provider is unavailable.' };
  }
  return { status: 'failed', code: 'CHAT_GENERATION_FAILED', message: 'The AI response could not be generated.' };
}

interface ActiveGeneration {
  ownerId: string;
  conversationId: string;
  requestId: string;
  controller: AbortController;
  cancelRequested: boolean;
  timedOut: boolean;
  outputLimit: boolean;
}

export interface PreparedChatGeneration {
  ownerId: string;
  conversationId: string;
  requestId: string;
  model?: string;
  messages: AiMessage[];
  temperature?: number;
  startedAt: Date;
}

export type ChatStreamEvent =
  | { type: 'generation'; requestId: string; status: 'running' }
  | { type: 'start'; requestId: string; provider: string; model: string }
  | { type: 'delta'; requestId: string; content: string }
  | { type: 'usage'; requestId: string; usage: AiUsage }
  | { type: 'completed'; requestId: string; generation: ChatGenerationState };

export class ChatService {
  private readonly active = new Map<string, ActiveGeneration>();

  constructor(
    private readonly repository: ChatRepository = mongooseChatRepository,
    private readonly projects: Pick<ProjectService, 'resolveActiveProject'> = projectService,
    private readonly provider: () => AiProviderClient = getAiProvider,
    private readonly timeoutMs: number = CHAT_LIMITS.timeoutMs,
    private readonly now: () => Date = () => new Date(),
    private readonly createRequestId: () => string = randomUUID
  ) {}

  async prepare(ownerIdValue: unknown, conversationIdValue: unknown, inputValue: unknown): Promise<PreparedChatGeneration> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const conversationId = requireObjectId(conversationIdValue, 'Conversation id');
    const input = validateChatStreamInput(inputValue);
    let current: ChatConversationRecord | null;
    try {
      current = await this.repository.findByOwnerAndId(ownerId, conversationId);
    } catch {
      throw new ChatError('Chat storage is unavailable.', 'CHAT_STORAGE_UNAVAILABLE', 503);
    }
    if (!current) throw new ChatError('Conversation not found.', 'CHAT_NOT_FOUND', 404);
    await this.projects.resolveActiveProject(ownerId, current.projectId ? String(current.projectId) : undefined);
    if (current.generation?.status === 'running') {
      throw new ChatError('This conversation already has a running generation.', 'CHAT_BUSY', 409);
    }
    if (Math.max(current.metadata?.messageCount ?? 0, current.messages.length) >= CHAT_LIMITS.messageRetention - 1) {
      throw new ChatError('This conversation reached its saved message limit.', 'CHAT_LIMIT_REACHED', 409);
    }

    const requestId = this.createRequestId();
    const startedAt = this.now();
    const userMessageId = new Types.ObjectId();
    const userMessage: ConversationMessage & { _id: unknown } = {
      _id: userMessageId,
      role: 'user',
      content: input.message,
      timestamp: startedAt,
      requestId,
    };
    let begun: ChatConversationRecord | null;
    try {
      begun = await this.repository.begin(ownerId, conversationId, userMessage, {
        requestId,
        status: 'running',
        userMessageId,
        outputBytes: 0,
        startedAt,
        deadlineAt: new Date(startedAt.getTime() + this.timeoutMs),
      });
    } catch {
      throw new ChatError('Chat storage is unavailable.', 'CHAT_STORAGE_UNAVAILABLE', 503);
    }
    if (!begun) {
      throw new ChatError('The conversation changed before generation could start.', 'CHAT_CONFLICT', 409);
    }
    return {
      ownerId,
      conversationId,
      requestId,
      ...(input.model ? { model: input.model } : begun.settings?.model ? { model: begun.settings.model } : {}),
      messages: buildProviderMessages(begun.messages),
      ...(begun.settings?.temperature !== undefined ? { temperature: begun.settings.temperature } : {}),
      startedAt,
    };
  }

  async execute(
    prepared: PreparedChatGeneration,
    onEvent: (event: ChatStreamEvent) => void,
    externalSignal?: AbortSignal
  ): Promise<ChatGenerationState> {
    if (this.active.has(prepared.requestId)) {
      throw new ChatError('The chat generation is already running.', 'CHAT_CONFLICT', 409);
    }
    const active: ActiveGeneration = {
      ownerId: prepared.ownerId,
      conversationId: prepared.conversationId,
      requestId: prepared.requestId,
      controller: new AbortController(),
      cancelRequested: false,
      timedOut: false,
      outputLimit: false,
    };
    this.active.set(prepared.requestId, active);
    const externalAbort = (): void => {
      active.cancelRequested = true;
      active.controller.abort();
    };
    if (externalSignal?.aborted) externalAbort();
    else externalSignal?.addEventListener('abort', externalAbort, { once: true });
    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.controller.abort();
    }, this.timeoutMs);
    timeout.unref();

    let output = '';
    let outputBytes = 0;
    let provider = 'configured';
    let model = prepared.model || 'default';
    let usage: AiUsage | undefined;
    let timeToFirstTokenMs: number | undefined;
    let acceptingEvents = true;
    let sawDone = false;
    onEvent({ type: 'generation', requestId: prepared.requestId, status: 'running' });

    try {
      const providerPromise = this.provider().chatStream(
        {
          ...(prepared.model ? { model: prepared.model } : {}),
          messages: prepared.messages,
          ...(prepared.temperature !== undefined ? { temperature: prepared.temperature } : {}),
        },
        (event: AiStreamEvent) => {
          if (!acceptingEvents || active.controller.signal.aborted) return;
          provider = safeRuntimeLabel(event.provider, 80, 'configured');
          model = safeRuntimeLabel(event.model, CHAT_LIMITS.modelBytes, prepared.model || 'default');
          if (event.type === 'start') {
            void this.repository.markStarted(prepared.ownerId, prepared.conversationId, prepared.requestId, provider, model)
              .catch(() => undefined);
            onEvent({ type: 'start', requestId: prepared.requestId, provider, model });
          } else if (event.type === 'delta') {
            const remaining = CHAT_LIMITS.outputBytes - outputBytes;
            const accepted = utf8Prefix(event.content, remaining);
            if (accepted) {
              if (timeToFirstTokenMs === undefined) {
                timeToFirstTokenMs = Math.max(0, this.now().getTime() - prepared.startedAt.getTime());
                void this.repository.markStarted(
                  prepared.ownerId,
                  prepared.conversationId,
                  prepared.requestId,
                  provider,
                  model,
                  timeToFirstTokenMs
                ).catch(() => undefined);
              }
              output += accepted;
              outputBytes += Buffer.byteLength(accepted, 'utf8');
              onEvent({ type: 'delta', requestId: prepared.requestId, content: accepted });
            }
            if (accepted !== event.content || outputBytes >= CHAT_LIMITS.outputBytes) {
              active.outputLimit = true;
              active.controller.abort();
            }
          } else if (event.type === 'usage' || event.type === 'done') {
            usage = normalizeUsage(event.usage) ?? usage;
            if (usage) onEvent({ type: 'usage', requestId: prepared.requestId, usage });
            if (event.type === 'done') sawDone = true;
          }
        },
        { signal: active.controller.signal }
      );
      // Some third-party clients do not honor AbortSignal. Race the provider so Stop
      // and the service timeout still become durable terminal states promptly.
      const aborted = new Promise<never>((_resolve, reject) => {
        if (active.controller.signal.aborted) reject(new Error('Generation stopped.'));
        else active.controller.signal.addEventListener(
          'abort',
          () => reject(new Error('Generation stopped.')),
          { once: true }
        );
      });
      providerPromise.catch(() => undefined);
      await Promise.race([providerPromise, aborted]);
      if (active.controller.signal.aborted) throw new Error('Generation stopped.');
      if (!sawDone) throw new Error('The provider stream ended without a terminal event.');
      if (!output) throw new Error('The provider returned an empty response.');
      acceptingEvents = false;
      const completedAt = this.now();
      const terminal: ChatTerminalData = {
        status: 'succeeded',
        content: output,
        provider,
        model,
        outputBytes,
        ...(usage ? { usage } : {}),
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - prepared.startedAt.getTime()),
        ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      };
      const saved = await this.finish(prepared, terminal);
      onEvent({ type: 'completed', requestId: prepared.requestId, generation: saved.generation as ChatGenerationState });
      return saved.generation as ChatGenerationState;
    } catch (error) {
      acceptingEvents = false;
      const failure = publicFailure(error, active);
      const completedAt = this.now();
      const terminal: ChatTerminalData = {
        status: failure.status,
        content: output,
        provider,
        model,
        outputBytes,
        ...(usage ? { usage } : {}),
        error: { code: failure.code, message: failure.message },
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - prepared.startedAt.getTime()),
        ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      };
      const saved = await this.finish(prepared, terminal);
      onEvent({ type: 'completed', requestId: prepared.requestId, generation: saved.generation as ChatGenerationState });
      return saved.generation as ChatGenerationState;
    } finally {
      acceptingEvents = false;
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', externalAbort);
      this.active.delete(prepared.requestId);
    }
  }

  cancel(ownerIdValue: unknown, conversationIdValue: unknown, requestIdValue: unknown): { requestId: string; cancelRequested: true } {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const conversationId = requireObjectId(conversationIdValue, 'Conversation id');
    if (typeof requestIdValue !== 'string' || !/^[\w-]{8,80}$/.test(requestIdValue)) {
      throw new ChatError('Generation request id is invalid.', 'INVALID_CHAT_INPUT', 400);
    }
    const active = this.active.get(requestIdValue);
    if (!active || active.ownerId !== ownerId || active.conversationId !== conversationId) {
      throw new ChatError('The running chat generation was not found.', 'CHAT_NOT_FOUND', 404);
    }
    active.cancelRequested = true;
    active.controller.abort();
    return { requestId: requestIdValue, cancelRequested: true };
  }

  async recoverInterrupted(): Promise<number> {
    const completedAt = this.now();
    try {
      return await this.repository.interruptActive(
        new Date(completedAt.getTime() - Math.max(this.timeoutMs * 2, 60_000)),
        completedAt
      );
    } catch {
      throw new ChatError('Chat storage is unavailable.', 'CHAT_STORAGE_UNAVAILABLE', 503);
    }
  }

  private async finish(prepared: PreparedChatGeneration, terminal: ChatTerminalData): Promise<ChatConversationRecord> {
    try {
      const saved = await this.repository.finish(
        prepared.ownerId,
        prepared.conversationId,
        prepared.requestId,
        terminal
      );
      if (!saved) throw new ChatError('The chat generation state changed unexpectedly.', 'CHAT_CONFLICT', 409);
      return saved;
    } catch (error) {
      if (error instanceof ChatError) throw error;
      throw new ChatError('Chat storage is unavailable.', 'CHAT_STORAGE_UNAVAILABLE', 503);
    }
  }
}

export const chatService = new ChatService();
