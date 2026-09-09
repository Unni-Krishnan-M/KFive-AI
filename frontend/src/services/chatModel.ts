export const CHAT_PROMPT_CHARACTER_LIMIT = 4_000;
export const CHAT_PROMPT_BYTE_LIMIT = 16 * 1024;
export const CHAT_OUTPUT_BYTE_LIMIT = 256 * 1024;

export type ChatGenerationStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'output_limit'
  | 'interrupted';

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  loadDurationMs?: number;
}

export interface ChatPublicError { code: string; message: string }

export interface ChatGeneration {
  requestId: string;
  status: ChatGenerationStatus;
  userMessageId?: string;
  provider?: string;
  model?: string;
  outputBytes: number;
  usage?: ChatUsage;
  error?: ChatPublicError;
  startedAt?: string;
  deadlineAt?: string;
  completedAt?: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

export interface ChatMessage {
  _id?: string;
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  requestId?: string;
  status?: Exclude<ChatGenerationStatus, 'running'>;
  provider?: string;
  model?: string;
  usage?: ChatUsage;
  error?: ChatPublicError;
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

export interface ChatConversation {
  _id: string;
  title: string;
  updatedAt?: string;
  projectId?: string;
  messages: ChatMessage[];
  generation?: ChatGeneration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim();
  if (!normalized || [...normalized].length > maximum || /[\p{Cc}\p{Cf}]/u.test(normalized)) return undefined;
  return normalized;
}

function boundedNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? Math.floor(value)
    : undefined;
}

function optionalDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

function normalizeError(value: unknown): ChatPublicError | undefined {
  if (!isRecord(value)) return undefined;
  const code = safeString(value.code, 80);
  const message = safeString(value.message, 300);
  return code && message ? { code, message } : undefined;
}

export function normalizeChatUsage(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: ChatUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const number = boundedNumber(value[key], key === 'totalTokens' ? 200_000_000 : 100_000_000);
    if (number !== undefined) usage[key] = number;
  }
  for (const key of ['totalDurationMs', 'loadDurationMs'] as const) {
    const number = boundedNumber(value[key], 86_400_000);
    if (number !== undefined) usage[key] = number;
  }
  return Object.keys(usage).length ? usage : undefined;
}

const statuses = new Set<ChatGenerationStatus>([
  'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted',
]);

export function normalizeChatGeneration(value: unknown): ChatGeneration | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = safeString(value.requestId, 80);
  const status = typeof value.status === 'string' && statuses.has(value.status as ChatGenerationStatus)
    ? value.status as ChatGenerationStatus
    : undefined;
  const outputBytes = boundedNumber(value.outputBytes, CHAT_OUTPUT_BYTE_LIMIT);
  if (!requestId || !status || outputBytes === undefined) return undefined;
  const generation: ChatGeneration = { requestId, status, outputBytes };
  const userMessageId = safeString(value.userMessageId, 80);
  const provider = safeString(value.provider, 80);
  const model = safeString(value.model, 200);
  const usage = normalizeChatUsage(value.usage);
  const error = normalizeError(value.error);
  const durationMs = boundedNumber(value.durationMs, 86_400_000);
  const timeToFirstTokenMs = boundedNumber(value.timeToFirstTokenMs, 86_400_000);
  const startedAt = optionalDate(value.startedAt);
  const deadlineAt = optionalDate(value.deadlineAt);
  const completedAt = optionalDate(value.completedAt);
  return {
    ...generation,
    ...(userMessageId ? { userMessageId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
  };
}

function normalizeChatMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value) || !['user', 'assistant', 'system'].includes(String(value.role))
    || typeof value.content !== 'string') return undefined;
  if (new TextEncoder().encode(value.content).byteLength > CHAT_OUTPUT_BYTE_LIMIT) return undefined;
  const message: ChatMessage = { role: value.role as ChatMessage['role'], content: value.content };
  const id = safeString(value._id, 80);
  const requestId = safeString(value.requestId, 80);
  const status = typeof value.status === 'string' && value.status !== 'running'
    && statuses.has(value.status as ChatGenerationStatus)
    ? value.status as Exclude<ChatGenerationStatus, 'running'>
    : undefined;
  const provider = safeString(value.provider, 80);
  const model = safeString(value.model, 200);
  const usage = normalizeChatUsage(value.usage);
  const error = normalizeError(value.error);
  const durationMs = boundedNumber(value.durationMs, 86_400_000);
  const timeToFirstTokenMs = boundedNumber(value.timeToFirstTokenMs, 86_400_000);
  return {
    ...message,
    ...(id ? { _id: id } : {}),
    ...(requestId ? { requestId } : {}),
    ...(status ? { status } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
  };
}

export function normalizeChatConversation(value: unknown): ChatConversation {
  if (!isRecord(value)) throw new Error('The conversation response is invalid.');
  const id = safeString(value._id ?? value.id, 80);
  const title = safeString(value.title, 200);
  if (!id || !title) throw new Error('The conversation response is invalid.');
  const rawMessages = value.messages === undefined ? [] : value.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length > 64) throw new Error('The conversation history is invalid.');
  const messages = rawMessages.map(normalizeChatMessage);
  if (messages.some((message) => !message)) throw new Error('The conversation history is invalid.');
  const projectId = safeString(value.projectId, 80);
  const updatedAt = optionalDate(value.updatedAt);
  const generation = normalizeChatGeneration(value.generation);
  if (value.generation !== undefined && !generation) throw new Error('The conversation generation state is invalid.');
  return {
    _id: id,
    title,
    messages: messages as ChatMessage[],
    ...(projectId ? { projectId } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(generation ? { generation } : {}),
  };
}

export interface ChatPromptValidation {
  value?: string;
  characters: number;
  bytes: number;
  error?: string;
}

export function validateChatPrompt(value: string): ChatPromptValidation {
  const normalized = value.normalize('NFC').trim();
  const characters = [...normalized].length;
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (!normalized) return { characters, bytes, error: 'Enter a message.' };
  if (characters > CHAT_PROMPT_CHARACTER_LIMIT || bytes > CHAT_PROMPT_BYTE_LIMIT) {
    return { characters, bytes, error: 'Messages are limited to 4,000 characters and 16 KiB.' };
  }
  const unsafe = [...normalized].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
  });
  if (unsafe) return { characters, bytes, error: 'The message contains unsupported control characters.' };
  return { value: normalized, characters, bytes };
}

export type ChatProtocolEvent =
  | { type: 'generation'; requestId: string }
  | { type: 'start'; requestId: string; provider: string; model: string }
  | { type: 'delta'; requestId: string; content: string }
  | { type: 'usage'; requestId: string; usage: ChatUsage }
  | { type: 'completed'; requestId: string; generation: ChatGeneration }
  | { type: 'error'; requestId: string; error: ChatPublicError }
  | { type: 'done'; requestId: string };

export class ChatStreamProtocol {
  private requestId?: string;
  private started = false;
  private terminal = false;
  private done = false;
  private outputBytes = 0;

  consume(data: string, event?: string, id?: string): ChatProtocolEvent {
    if (this.done) throw new Error('The chat stream sent data after completion.');
    if (data === '[DONE]') {
      if (!this.requestId || !this.terminal) throw new Error('The chat stream ended before a terminal event.');
      this.done = true;
      return { type: 'done', requestId: this.requestId };
    }
    if (!event || !id || !['generation', 'start', 'delta', 'usage', 'completed', 'error'].includes(event)) {
      throw new Error('The chat stream contains an unsupported event.');
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) throw new Error('invalid');
      payload = parsed;
    } catch {
      throw new Error('The chat stream contains invalid JSON.');
    }
    const requestId = safeString(payload.requestId, 80);
    if (!requestId || requestId !== id || (this.requestId && this.requestId !== requestId)) {
      throw new Error('The chat stream request identity changed unexpectedly.');
    }
    if (event === 'generation') {
      if (this.requestId || payload.status !== 'running') throw new Error('The chat stream generation event is invalid.');
      this.requestId = requestId;
      return { type: 'generation', requestId };
    }
    if (!this.requestId) throw new Error('The chat stream did not begin with a generation event.');
    if (event === 'start') {
      if (this.started || this.terminal) throw new Error('The chat stream start event is invalid.');
      const provider = safeString(payload.provider, 80);
      const model = safeString(payload.model, 200);
      if (!provider || !model) throw new Error('The chat stream provider selection is invalid.');
      this.started = true;
      return { type: 'start', requestId, provider, model };
    }
    if (event === 'delta') {
      if (!this.started || this.terminal || typeof payload.content !== 'string') {
        throw new Error('The chat stream delta is out of sequence.');
      }
      this.outputBytes += new TextEncoder().encode(payload.content).byteLength;
      if (this.outputBytes > CHAT_OUTPUT_BYTE_LIMIT) throw new Error('The chat stream exceeded its output limit.');
      return { type: 'delta', requestId, content: payload.content };
    }
    if (event === 'usage') {
      if (!this.started || this.terminal) throw new Error('The chat stream usage event is out of sequence.');
      const usage = normalizeChatUsage(payload.usage);
      if (!usage) throw new Error('The chat stream usage event is invalid.');
      return { type: 'usage', requestId, usage };
    }
    if (this.terminal) throw new Error('The chat stream sent more than one terminal event.');
    this.terminal = true;
    if (event === 'completed') {
      const generation = normalizeChatGeneration(payload.generation);
      if (!generation || generation.requestId !== requestId || generation.status === 'running') {
        throw new Error('The chat stream completion event is invalid.');
      }
      return { type: 'completed', requestId, generation };
    }
    const code = safeString(payload.code, 80);
    const message = safeString(payload.message, 300);
    if (!code || !message) throw new Error('The chat stream error event is invalid.');
    return { type: 'error', requestId, error: { code, message } };
  }

  finish(): void {
    if (!this.done) throw new Error('The chat stream closed before [DONE].');
  }
}

export function chatGenerationLabel(status: Exclude<ChatGenerationStatus, 'running'>): string {
  return ({
    succeeded: 'Completed',
    failed: 'Generation failed',
    cancelled: 'Generation stopped',
    timed_out: 'Provider timed out',
    output_limit: 'Output limit reached',
    interrupted: 'Generation interrupted',
  })[status];
}
