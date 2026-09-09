import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { NotebookCell } from '@/models/Notebook';
import {
  ExecFileNotebookDockerClient,
  NotebookDockerAbortedError,
  NotebookDockerClient,
  NotebookDockerResult,
} from './notebookDocker';

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,499}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_PATH = /^artifacts\/(?:[A-Za-z0-9_.-]+\/){0,7}[A-Za-z0-9_.-]+$/;
const ENVELOPE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,7}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_NOTEBOOK_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_TOTAL = 4 * 1024 * 1024;

export interface NotebookExecutionRequest {
  runId: string;
  cells: NotebookCell[];
  cellTimeoutSeconds: number;
}
export interface NotebookExecutionArtifact {
  path: string; kind: 'text' | 'json' | 'png' | 'jpeg'; mimeType: string; bytes: number; sha256: string; data: Buffer;
}
export interface NotebookExecutionResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'resource_exceeded' | 'interrupted';
  durationMs: number;
  runtimeImageId: string;
  verifierImageId: string;
  executedNotebookJson?: string;
  metrics: Array<{ name: string; value: number; step?: number }>;
  artifacts: NotebookExecutionArtifact[];
  error?: { code: string; message: string; cellIndex?: number };
}
export interface NotebookExecutorConfig {
  runtimeImage: string;
  verifierImage: string;
  requireAppArmor?: boolean;
  memoryBytes?: number;
  cpuCores?: number;
  processLimit?: number;
  wallTimeoutMs?: number;
}
export interface NotebookExecutionLifecycle { runtimeRemoved(): Promise<void> }

export class NotebookIsolationError extends Error {
  constructor(message: string, readonly code = 'NOTEBOOK_ISOLATION_FAILED') { super(message); this.name = 'NotebookIsolationError'; }
}

function requireSuccess(result: NotebookDockerResult, operation: string): NotebookDockerResult {
  if (result.exitCode !== 0) throw new NotebookIsolationError(`Docker ${operation} failed.`);
  return result;
}
function image(value: string, label: string): string {
  if (!IMAGE.test(value) || value.startsWith('-')) throw new NotebookIsolationError(`${label} image reference is invalid.`);
  return value;
}
function canonicalJson(value: unknown): string { return `${JSON.stringify(value)}\n`; }
function safeDiagnostic(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 512) || 'no supervisor diagnostic';
}
function preloadEnvelope(files: Array<{ path: string; data: Buffer }>): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: 'kfive.notebook-files.v1', files: files.map(({ path, data }) => ({
    path, data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'),
  })) }));
}
function notebookInput(cells: NotebookCell[]) {
  return {
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    cells: cells.map((cell) => cell.type === 'code'
      ? { cell_type: 'code', id: cell.id, metadata: cell.tags.length ? { tags: cell.tags } : {},
        source: cell.source, execution_count: null, outputs: [] }
      : { cell_type: 'markdown', id: cell.id, metadata: cell.tags.length ? { tags: cell.tags } : {}, source: cell.source }),
  };
}
function runtimeCreateArgs(name: string, imageRef: string, config: Required<Pick<NotebookExecutorConfig,
  'requireAppArmor' | 'memoryBytes' | 'cpuCores' | 'processLimit'>>): string[] {
  const memory = String(config.memoryBytes);
  return ['create', '--pull', 'never', '--name', name, '--label', 'com.kfive.notebook-runtime=true',
    '--user', '10001:10001', '--read-only', '--network', 'none', '--ipc', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', ...(config.requireAppArmor ? ['--security-opt', 'apparmor=docker-default'] : []),
    '--pids-limit', String(config.processLimit), '--cpus', String(config.cpuCores), '--memory', memory, '--memory-swap', memory,
    '--ulimit', 'nofile=128:128', '--ulimit', `nproc=${config.processLimit}:${config.processLimit}`, '--ulimit', 'core=0:0',
    '--tmpfs', '/work/input:rw,noexec,nosuid,nodev,size=6m,uid=0,gid=0,mode=0755',
    '--tmpfs', '/work/output:rw,noexec,nosuid,nodev,size=10m,uid=10001,gid=10001,mode=0700',
    '--tmpfs', '/work/run:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700',
    '--hostname', 'kfive-notebook', '--env', 'HOME=/work/run/.home', '--env', 'LANG=C.UTF-8', '--log-driver', 'none',
    '--stop-timeout', '1', '--init', '--entrypoint', '/usr/bin/sleep', imageRef, 'infinity'];
}
function verifierCreateArgs(name: string, imageRef: string, requireAppArmor: boolean): string[] {
  return ['create', '--pull', 'never', '--name', name, '--label', 'com.kfive.notebook-verifier=true',
    '--user', '10002:10002', '--read-only', '--network', 'none', '--ipc', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', ...(requireAppArmor ? ['--security-opt', 'apparmor=docker-default'] : []),
    '--pids-limit', '32', '--cpus', '0.5', '--memory', '268435456', '--memory-swap', '268435456',
    '--ulimit', 'nofile=64:64', '--ulimit', 'nproc=32:32', '--ulimit', 'core=0:0',
    '--tmpfs', '/verify/input:rw,noexec,nosuid,nodev,size=6m,uid=0,gid=0,mode=0755',
    '--tmpfs', '/verify/candidate:rw,noexec,nosuid,nodev,size=10m,uid=0,gid=0,mode=0755',
    '--tmpfs', '/verify/output:rw,noexec,nosuid,nodev,size=10m,uid=10002,gid=10002,mode=0700',
    '--log-driver', 'none', '--stop-timeout', '1', '--init', '--entrypoint', '/usr/bin/sleep', imageRef, 'infinity'];
}

async function imageId(docker: NotebookDockerClient, imageRef: string): Promise<string> {
  const result = requireSuccess(await docker.run(['image', 'inspect', '--format', '{{.Id}}', imageRef],
    { maxOutputBytes: 4_096, timeoutMs: 10_000 }), 'image inspection');
  const id = result.stdout.trim().replace(/^sha256:/, '');
  if (!SHA256.test(id)) throw new NotebookIsolationError('Docker returned an invalid image identity.');
  return id;
}

async function safeFile(path: string, maximum: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximum)
    throw new NotebookIsolationError('Verified output contains an unsafe file.');
  const data = await readFile(path);
  if (data.length !== metadata.size || data.length > maximum) throw new NotebookIsolationError('Verified output changed while being read.');
  return data;
}
async function inventory(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true }); const files: string[] = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new NotebookIsolationError('Verified output contains a symbolic link.');
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new NotebookIsolationError('Verified output contains a special file.');
  }
  return files.sort();
}
async function directoryEnvelope(root: string): Promise<Buffer> {
  const paths = await inventory(root); let total = 0; const files: Array<{ path: string; data: Buffer }> = [];
  if (paths.length < 1 || paths.length > 64) throw new NotebookIsolationError('Preload file count is invalid.');
  for (const path of paths) {
    const data = await safeFile(join(root, path), 5 * 1024 * 1024); total += data.length;
    if (total > 10 * 1024 * 1024) throw new NotebookIsolationError('Preload data exceeds its byte limit.');
    files.push({ path, data });
  }
  const envelope = preloadEnvelope(files);
  if (envelope.length > 16 * 1024 * 1024) throw new NotebookIsolationError('Preload envelope exceeds its byte limit.');
  return envelope;
}
async function importEnvelope(root: string, raw: string): Promise<void> {
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length > 16 * 1024 * 1024) throw new NotebookIsolationError('Export envelope exceeds its byte limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new NotebookIsolationError('Export envelope JSON is invalid.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join('|') !== 'files|schemaVersion')
    throw new NotebookIsolationError('Export envelope contract is invalid.');
  const envelope = parsed as { schemaVersion?: unknown; files?: unknown };
  if (envelope.schemaVersion !== 'kfive.notebook-files.v1' || !Array.isArray(envelope.files)
    || envelope.files.length < 1 || envelope.files.length > 64)
    throw new NotebookIsolationError('Export envelope values are invalid.');
  const seen = new Set<string>(); let total = 0;
  for (const value of envelope.files) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('|') !== 'data|path|sha256')
      throw new NotebookIsolationError('Export file contract is invalid.');
    const record = value as { path?: unknown; data?: unknown; sha256?: unknown };
    if (typeof record.path !== 'string' || !ENVELOPE_PATH.test(record.path) || record.path.includes('..')
      || record.path.split('/').some((part) => part.startsWith('.')) || seen.has(record.path)
      || typeof record.data !== 'string' || record.data.length > (5 * 1024 * 1024 * 4 / 3) + 8
      || !BASE64.test(record.data) || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256))
      throw new NotebookIsolationError('Export file record is invalid.');
    const data = Buffer.from(record.data, 'base64'); total += data.length;
    if (data.toString('base64') !== record.data || data.length > 5 * 1024 * 1024 || total > 10 * 1024 * 1024
      || createHash('sha256').update(data).digest('hex') !== record.sha256)
      throw new NotebookIsolationError('Export file integrity is invalid.');
    const path = resolve(root, record.path); const prefix = resolve(root) + sep;
    if (!path.startsWith(prefix)) throw new NotebookIsolationError('Export file escapes its root.');
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: 'wx', mode: 0o600 }); seen.add(record.path);
  }
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|'))
    throw new NotebookIsolationError('Verified result contract is invalid.');
  return value as Record<string, unknown>;
}
function safeArtifactPath(root: string, value: unknown): string {
  if (typeof value !== 'string' || !ARTIFACT_PATH.test(value) || value.includes('..'))
    throw new NotebookIsolationError('Verified artifact path is invalid.');
  const result = resolve(root, value); const prefix = resolve(root) + sep;
  if (!result.startsWith(prefix)) throw new NotebookIsolationError('Verified artifact path escapes its root.');
  return result;
}

async function readVerified(root: string, runId: string, runtimeImageId: string, verifierImageId: string): Promise<NotebookExecutionResult> {
  const resultBytes = await safeFile(join(root, 'result.json'), MAX_RESULT_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(resultBytes.toString('utf8')); } catch { throw new NotebookIsolationError('Verified result JSON is invalid.'); }
  const result = exactObject(parsed, ['schemaVersion', 'runId', 'status', 'startedAt', 'finishedAt', 'durationMs', 'notebookFile', 'metrics', 'artifacts', 'error']);
  if (result.schemaVersion !== 'kfive.notebook-result.v1' || result.runId !== runId
    || (result.status !== 'succeeded' && result.status !== 'failed')
    || typeof result.durationMs !== 'number' || !Number.isInteger(result.durationMs) || result.durationMs < 0 || result.durationMs > 300_000)
    throw new NotebookIsolationError('Verified result values are invalid.');
  const base = { durationMs: result.durationMs, runtimeImageId, verifierImageId };
  if (result.status === 'failed') {
    const files = await inventory(root); const error = exactObject(result.error, ['code', 'message', 'cellIndex']);
    if (files.length !== 1 || files[0] !== 'result.json' || result.notebookFile !== null
      || !Array.isArray(result.metrics) || result.metrics.length !== 0 || !Array.isArray(result.artifacts) || result.artifacts.length !== 0
      || typeof error.code !== 'string' || typeof error.message !== 'string')
      throw new NotebookIsolationError('Verified failure bundle is invalid.');
    return { status: 'failed', ...base, metrics: [], artifacts: [], error: { code: error.code, message: error.message,
      ...(typeof error.cellIndex === 'number' ? { cellIndex: error.cellIndex } : {}) } };
  }
  if (result.notebookFile !== 'executed.ipynb' || result.error !== null || !Array.isArray(result.metrics) || !Array.isArray(result.artifacts))
    throw new NotebookIsolationError('Verified success bundle is invalid.');
  const notebookBytes = await safeFile(join(root, 'executed.ipynb'), MAX_NOTEBOOK_BYTES);
  try { JSON.parse(notebookBytes.toString('utf8')); } catch { throw new NotebookIsolationError('Verified notebook JSON is invalid.'); }
  const metrics = result.metrics.map((item) => {
    const metric = exactObject(item, ['name', 'value', 'step']);
    if (typeof metric.name !== 'string' || typeof metric.value !== 'number' || !Number.isFinite(metric.value)
      || (metric.step !== null && (typeof metric.step !== 'number' || !Number.isInteger(metric.step))))
      throw new NotebookIsolationError('Verified metric is invalid.');
    return { name: metric.name, value: metric.value, ...(typeof metric.step === 'number' ? { step: metric.step } : {}) };
  });
  if (metrics.length > 1_000) throw new NotebookIsolationError('Verified metric limit was exceeded.');
  let total = 0;
  const artifacts: NotebookExecutionArtifact[] = [];
  for (const item of result.artifacts) {
    const record = exactObject(item, ['path', 'kind', 'mimeType', 'bytes', 'sha256']);
    const path = safeArtifactPath(root, record.path);
    const mimeByKind = { text: 'text/plain; charset=utf-8', json: 'application/json', png: 'image/png', jpeg: 'image/jpeg' } as const;
    if (!Object.prototype.hasOwnProperty.call(mimeByKind, String(record.kind))
      || record.mimeType !== mimeByKind[record.kind as keyof typeof mimeByKind]
      || typeof record.bytes !== 'number' || !Number.isInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_ARTIFACT_BYTES
      || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256))
      throw new NotebookIsolationError('Verified artifact record is invalid.');
    const data = await safeFile(path, MAX_ARTIFACT_BYTES); total += data.length;
    if (data.length !== record.bytes || total > MAX_ARTIFACT_TOTAL
      || createHash('sha256').update(data).digest('hex') !== record.sha256)
      throw new NotebookIsolationError('Verified artifact bytes do not match their manifest.');
    artifacts.push({ path: record.path as string, kind: record.kind as NotebookExecutionArtifact['kind'],
      mimeType: record.mimeType as string, bytes: record.bytes, sha256: record.sha256, data });
  }
  if (artifacts.length > 20) throw new NotebookIsolationError('Verified artifact count was exceeded.');
  const expected = ['executed.ipynb', 'result.json', ...artifacts.map((item) => item.path)].sort();
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(expected)) throw new NotebookIsolationError('Verified output inventory is invalid.');
  return { status: 'succeeded', ...base, executedNotebookJson: notebookBytes.toString('utf8'), metrics, artifacts };
}

export class DockerNotebookExecutor {
  private readonly runtimeImage: string;
  private readonly verifierImage: string;
  private readonly requireAppArmor: boolean;
  private readonly memoryBytes: number;
  private readonly cpuCores: number;
  private readonly processLimit: number;
  private readonly wallTimeoutMs: number;

  constructor(private readonly docker: NotebookDockerClient = new ExecFileNotebookDockerClient(), config: NotebookExecutorConfig) {
    this.runtimeImage = image(config.runtimeImage, 'Runtime'); this.verifierImage = image(config.verifierImage, 'Verifier');
    if (this.runtimeImage === this.verifierImage) throw new NotebookIsolationError('Runtime and verifier image references must be distinct.');
    this.requireAppArmor = config.requireAppArmor ?? true;
    this.memoryBytes = config.memoryBytes ?? 768 * 1024 * 1024;
    this.cpuCores = config.cpuCores ?? 1;
    this.processLimit = config.processLimit ?? 128;
    this.wallTimeoutMs = config.wallTimeoutMs ?? 310_000;
    if (!Number.isSafeInteger(this.memoryBytes) || this.memoryBytes < 256 * 1024 * 1024 || this.memoryBytes > 1024 * 1024 * 1024
      || !Number.isFinite(this.cpuCores) || this.cpuCores < 0.1 || this.cpuCores > 2
      || !Number.isSafeInteger(this.processLimit) || this.processLimit < 32 || this.processLimit > 256
      || !Number.isSafeInteger(this.wallTimeoutMs) || this.wallTimeoutMs < 1_000 || this.wallTimeoutMs > 320_000)
      throw new NotebookIsolationError('Notebook executor limits are invalid.');
  }

  async imageIdentities(): Promise<{ runtimeImageId: string; verifierImageId: string }> {
    const [runtimeImageId, verifierImageId] = await Promise.all([
      imageId(this.docker, this.runtimeImage), imageId(this.docker, this.verifierImage),
    ]);
    if (runtimeImageId === verifierImageId) throw new NotebookIsolationError('Runtime and verifier resolve to the same image.');
    return { runtimeImageId, verifierImageId };
  }

  async verifyHostSecurity(): Promise<void> {
    const result = requireSuccess(await this.docker.run(['info', '--format', '{{json .SecurityOptions}}'],
      { maxOutputBytes: 16 * 1024, timeoutMs: 10_000 }), 'security inspection');
    let options: unknown;
    try { options = JSON.parse(result.stdout); } catch { throw new NotebookIsolationError('Docker security options are invalid.'); }
    if (!Array.isArray(options) || !options.every((item) => typeof item === 'string')
      || !options.some((item) => item.startsWith('name=seccomp'))
      || (this.requireAppArmor && !options.some((item) => item === 'name=apparmor')))
      throw new NotebookIsolationError('Docker must provide seccomp and the configured AppArmor isolation policy.');
  }

  async reapOwnedContainers(): Promise<number> {
    const identifiers = new Set<string>();
    for (const label of ['com.kfive.notebook-runtime=true', 'com.kfive.notebook-verifier=true']) {
      const listed = requireSuccess(await this.docker.run(['ps', '-aq', '--filter', `label=${label}`],
        { maxOutputBytes: 64 * 1024, timeoutMs: 10_000 }), 'owned-container listing');
      for (const id of listed.stdout.split(/\s+/).filter(Boolean)) {
        if (!CONTAINER_ID.test(id)) throw new NotebookIsolationError('Docker returned an invalid owned container id.');
        identifiers.add(id);
      }
    }
    for (const id of identifiers) requireSuccess(await this.docker.run(['rm', '--force', '--volumes', id],
      { maxOutputBytes: 64 * 1024, timeoutMs: 10_000 }), 'stale owned-container removal');
    return identifiers.size;
  }

  async execute(
    request: NotebookExecutionRequest,
    cancellation?: AbortSignal,
    lifecycle?: NotebookExecutionLifecycle
  ): Promise<NotebookExecutionResult> {
    if (!/^[a-f0-9]{24}$/.test(request.runId) || !Array.isArray(request.cells) || request.cells.length < 1 || request.cells.length > 32
      || !Number.isInteger(request.cellTimeoutSeconds) || request.cellTimeoutSeconds < 1 || request.cellTimeoutSeconds > 30)
      throw new NotebookIsolationError('Notebook execution request is invalid.');
    const identities = await this.imageIdentities(); const started = Date.now();
    if (cancellation?.aborted) return { status: 'cancelled', durationMs: 0, ...identities, metrics: [], artifacts: [] };
    const root = await mkdtemp(join(tmpdir(), 'kfive-notebook-'));
    const input = join(root, 'input'); const candidate = join(root, 'candidate'); const verified = join(root, 'verified');
    const suffix = randomBytes(6).toString('hex'); const runtimeName = `kfive-nb-run-${request.runId}-${suffix}`;
    const verifierName = `kfive-nb-verify-${request.runId}-${suffix}`;
    let runtimeId: string | undefined; let verifierId: string | undefined; let runtimeRemoved = false;
    const controller = new AbortController(); let timedOut = false;
    const cancel = () => controller.abort(); cancellation?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.wallTimeoutMs); timer.unref();
    try {
      await Promise.all([mkdir(input, { mode: 0o700 }), mkdir(candidate, { mode: 0o700 }), mkdir(verified, { mode: 0o700 })]);
      await writeFile(join(input, 'manifest.json'), canonicalJson({ schemaVersion: 'kfive.notebook-job.v1', runId: request.runId,
        notebookFile: 'notebook.ipynb', cellTimeoutSeconds: request.cellTimeoutSeconds }), { mode: 0o444, flag: 'wx' });
      await writeFile(join(input, 'notebook.ipynb'), canonicalJson(notebookInput(request.cells)), { mode: 0o444, flag: 'wx' });
      const created = requireSuccess(await this.docker.run(runtimeCreateArgs(runtimeName, this.runtimeImage, {
        requireAppArmor: this.requireAppArmor, memoryBytes: this.memoryBytes, cpuCores: this.cpuCores, processLimit: this.processLimit,
      }), { signal: controller.signal, maxOutputBytes: 64 * 1024 }), 'runtime create');
      runtimeId = created.stdout.trim(); if (!CONTAINER_ID.test(runtimeId)) throw new NotebookIsolationError('Runtime container id is invalid.');
      requireSuccess(await this.docker.run(['start', runtimeId],
        { signal: controller.signal, maxOutputBytes: 64 * 1024 }), 'runtime hold start');
      requireSuccess(await this.docker.run(['exec', '--user', '0:0', '--interactive', runtimeId, '/opt/venv/bin/python', '-m',
        'kfive_notebook_runtime.preload', '--destination', '/work/input'],
      { signal: controller.signal, maxOutputBytes: 64 * 1024, input: await directoryEnvelope(input) }), 'runtime input preload');
      const runtimeResult = await this.docker.run(['exec', runtimeId, '/opt/venv/bin/python', '-m', 'kfive_notebook_runtime.supervisor'],
        { signal: controller.signal, maxOutputBytes: 256 * 1024 });
      const stateResult = requireSuccess(await this.docker.run(['inspect', '--format', '{{json .State}}', runtimeId],
        { maxOutputBytes: 64 * 1024, timeoutMs: 5_000 }), 'runtime state inspection');
      const state = JSON.parse(stateResult.stdout) as { OOMKilled?: boolean };
      if (state.OOMKilled || runtimeResult.exitCode === 137) return { status: 'resource_exceeded', durationMs: Date.now() - started, ...identities,
        metrics: [], artifacts: [], error: { code: 'NOTEBOOK_MEMORY_LIMIT', message: 'Notebook exceeded its memory limit.' } };
      if (![0, 1].includes(runtimeResult.exitCode)) throw new NotebookIsolationError('Notebook runtime exited unexpectedly.');
      const runtimeExport = await this.docker.run(['exec', runtimeId, '/opt/venv/bin/python', '-m',
        'kfive_notebook_runtime.exporter', '--source', '/work/output'],
      { maxOutputBytes: 17 * 1024 * 1024, timeoutMs: 10_000 });
      if (runtimeExport.exitCode !== 0)
        throw new NotebookIsolationError(`Notebook supervisor produced no export (${safeDiagnostic(runtimeResult.stderr)}).`);
      await importEnvelope(candidate, runtimeExport.stdout);
      requireSuccess(await this.docker.run(['rm', '--force', '--volumes', runtimeId],
        { maxOutputBytes: 64 * 1024, timeoutMs: 10_000 }), 'runtime removal');
      runtimeId = undefined; runtimeRemoved = true;
      if (controller.signal.aborted) return { status: timedOut ? 'timed_out' : 'cancelled', durationMs: Date.now() - started,
        ...identities, metrics: [], artifacts: [] };
      if (!runtimeRemoved) throw new NotebookIsolationError('Runtime removal was not proven before verification.');
      await lifecycle?.runtimeRemoved();
      if (controller.signal.aborted) return { status: timedOut ? 'timed_out' : 'cancelled', durationMs: Date.now() - started,
        ...identities, metrics: [], artifacts: [] };
      const verifierCreated = requireSuccess(await this.docker.run(verifierCreateArgs(verifierName, this.verifierImage,
        this.requireAppArmor), { signal: controller.signal, maxOutputBytes: 64 * 1024 }), 'verifier create');
      verifierId = verifierCreated.stdout.trim(); if (!CONTAINER_ID.test(verifierId)) throw new NotebookIsolationError('Verifier container id is invalid.');
      requireSuccess(await this.docker.run(['start', verifierId],
        { signal: controller.signal, maxOutputBytes: 64 * 1024 }), 'verifier hold start');
      requireSuccess(await this.docker.run(['exec', '--user', '0:0', '--interactive', verifierId, '/opt/venv/bin/python', '-m',
        'kfive_notebook_runtime.preload', '--destination', '/verify/input'],
      { signal: controller.signal, maxOutputBytes: 64 * 1024, input: await directoryEnvelope(input) }), 'verifier input preload');
      requireSuccess(await this.docker.run(['exec', '--user', '0:0', '--interactive', verifierId, '/opt/venv/bin/python', '-m',
        'kfive_notebook_runtime.preload', '--destination', '/verify/candidate'],
      { signal: controller.signal, maxOutputBytes: 64 * 1024, input: await directoryEnvelope(candidate) }), 'verifier candidate preload');
      const verifierResult = await this.docker.run(['exec', verifierId, '/opt/venv/bin/python', '-m',
        'kfive_notebook_runtime.verifier', '--run-id', request.runId],
        { signal: controller.signal, maxOutputBytes: 64 * 1024 });
      if (verifierResult.exitCode !== 0)
        throw new NotebookIsolationError(`Notebook output verification failed (${safeDiagnostic(verifierResult.stderr)}).`);
      const verifiedExport = requireSuccess(await this.docker.run(['exec', verifierId, '/opt/venv/bin/python', '-m',
        'kfive_notebook_runtime.exporter', '--source', '/verify/output'],
      { maxOutputBytes: 17 * 1024 * 1024, timeoutMs: 10_000 }), 'verified output export');
      await importEnvelope(verified, verifiedExport.stdout);
      requireSuccess(await this.docker.run(['rm', '--force', '--volumes', verifierId],
        { maxOutputBytes: 64 * 1024, timeoutMs: 10_000 }), 'verifier removal');
      verifierId = undefined;
      return await readVerified(verified, request.runId, identities.runtimeImageId, identities.verifierImageId);
    } catch (error) {
      if (error instanceof NotebookDockerAbortedError || controller.signal.aborted)
        return { status: timedOut ? 'timed_out' : 'cancelled', durationMs: Date.now() - started,
          ...identities, metrics: [], artifacts: [] };
      if (error instanceof NotebookIsolationError) throw error;
      throw new NotebookIsolationError('Notebook execution failed inside the trusted broker.');
    } finally {
      clearTimeout(timer); cancellation?.removeEventListener('abort', cancel);
      if (runtimeId) await this.docker.run(['rm', '--force', '--volumes', runtimeId], { maxOutputBytes: 64 * 1024, timeoutMs: 10_000 }).catch(() => undefined);
      if (verifierId) await this.docker.run(['rm', '--force', '--volumes', verifierId], { maxOutputBytes: 64 * 1024, timeoutMs: 10_000 }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
}

export { notebookInput, readVerified, runtimeCreateArgs, verifierCreateArgs };
