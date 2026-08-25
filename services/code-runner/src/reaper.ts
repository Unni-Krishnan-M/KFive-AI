import { DockerCommandAdapter, DockerCommandResult } from './dockerCli';

export const CODE_RUN_CONTAINER_LABEL = 'com.kfive.code-run=true';
export const DEFAULT_STALE_CONTAINER_AGE_MS = 120_000;

const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/i;
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;

interface ContainerInspection {
  Created?: unknown;
  Config?: {
    Labels?: unknown;
  };
  State?: {
    Running?: unknown;
  };
}

export interface ReaperResult {
  scanned: number;
  removed: number;
}

export interface ReaperOptions {
  now?: () => number;
  staleAfterMs?: number;
  onError?: (event: string) => void;
}

function successful(result: DockerCommandResult): boolean {
  return result.exitCode === 0;
}

function parseInspection(raw: string): { createdMs: number; running: boolean } | undefined {
  let inspection: ContainerInspection;
  try {
    inspection = JSON.parse(raw) as ContainerInspection;
  } catch {
    return undefined;
  }
  const labels = inspection.Config?.Labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return undefined;
  if ((labels as Record<string, unknown>)['com.kfive.code-run'] !== 'true') return undefined;
  if (typeof inspection.Created !== 'string' || typeof inspection.State?.Running !== 'boolean') return undefined;
  const createdMs = Date.parse(inspection.Created);
  if (!Number.isFinite(createdMs)) return undefined;
  return { createdMs, running: inspection.State.Running };
}

export class StaleCodeRunReaper {
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly onError: (event: string) => void;

  constructor(
    private readonly docker: DockerCommandAdapter,
    options: ReaperOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_CONTAINER_AGE_MS;
    this.onError = options.onError ?? (() => undefined);
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 30_000) {
      throw new Error('Stale container age must be a safe integer of at least 30 seconds.');
    }
  }

  async reap(): Promise<ReaperResult> {
    const summary = { scanned: 0, removed: 0 };
    let listed: DockerCommandResult;
    try {
      listed = await this.docker.run(
        ['ps', '--all', '--no-trunc', '--filter', `label=${CODE_RUN_CONTAINER_LABEL}`, '--format', '{{.ID}}'],
        { maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS }
      );
    } catch {
      this.onError('stale-container-list-failed');
      return summary;
    }
    if (!successful(listed)) {
      this.onError('stale-container-list-failed');
      return summary;
    }

    const candidates = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean))];
    for (const id of candidates) {
      if (!CONTAINER_ID_PATTERN.test(id)) {
        this.onError('stale-container-id-invalid');
        continue;
      }
      summary.scanned += 1;
      await this.reapCandidate(id, summary);
    }
    return summary;
  }

  private async reapCandidate(id: string, summary: ReaperResult): Promise<void> {
    let inspected: DockerCommandResult;
    try {
      inspected = await this.docker.run(
        ['inspect', '--format', '{{json .}}', id],
        { maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS }
      );
    } catch {
      this.onError('stale-container-inspect-failed');
      return;
    }
    if (!successful(inspected)) {
      this.onError('stale-container-inspect-failed');
      return;
    }

    const metadata = parseInspection(inspected.stdout);
    if (!metadata) {
      this.onError('stale-container-metadata-invalid');
      return;
    }
    const ageMs = this.now() - metadata.createdMs;
    if (!Number.isFinite(ageMs) || ageMs < this.staleAfterMs) return;

    if (metadata.running) {
      try {
        const killed = await this.docker.run(
          ['kill', id],
          { maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS }
        );
        if (!successful(killed)) this.onError('stale-container-kill-failed');
      } catch {
        this.onError('stale-container-kill-failed');
      }
    }

    try {
      const removed = await this.docker.run(
        ['rm', '--force', '--volumes', id],
        { maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS }
      );
      if (successful(removed)) summary.removed += 1;
      else this.onError('stale-container-remove-failed');
    } catch {
      this.onError('stale-container-remove-failed');
    }
  }
}

export { parseInspection };
