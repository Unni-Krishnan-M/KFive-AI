import { REPOSITORY_LIMITS, RepositoryArchiveError, analyzeRepositoryZip } from './services/repositoryArchiveAnalyzer';
import {
  REPOSITORY_ARCHIVE_METADATA_BYTES,
  decodeRepositoryArchiveRequest,
  encodeRepositoryArchiveFailure,
  encodeRepositoryArchiveSuccess,
} from './services/repositoryArchiveIsolationProtocol';

const maximumInput = 12 + REPOSITORY_ARCHIVE_METADATA_BYTES + REPOSITORY_LIMITS.archiveBytes;

async function readInput(): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maximumInput) throw new Error('Repository archive frame is too large.');
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function writeEnvelope(value: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.end(value, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  try {
    const request = decodeRepositoryArchiveRequest(await readInput());
    const report = await analyzeRepositoryZip(request.buffer, request.originalName, request.mimeType);
    await writeEnvelope(encodeRepositoryArchiveSuccess(report));
  } catch (error) {
    const code = error instanceof RepositoryArchiveError ? error.code : 'INTERNAL';
    await writeEnvelope(encodeRepositoryArchiveFailure(code));
  }
}

const keepAlive = setInterval(() => undefined, 1_000);
void main()
  .catch(() => { process.exitCode = 1; })
  .finally(() => clearInterval(keepAlive));
