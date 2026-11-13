import {
  createRepositoryImporterAnalyzer,
  validateRepositoryImporterSocketPath,
} from './services/repositoryImporterClient';
import { REPOSITORY_IMPORTER_SOCKET_PATH } from './services/repositoryArchiveIsolationProtocol';

async function main(): Promise<void> {
  const configured = validateRepositoryImporterSocketPath(process.env.REPOSITORY_IMPORTER_SOCKET_PATH || '');
  if (configured !== REPOSITORY_IMPORTER_SOCKET_PATH) throw new Error('Repository importer requires the fixed socket path.');
  if (!await createRepositoryImporterAnalyzer({ socketPath: configured, connectTimeoutMs: 400 }).isAvailable()) {
    throw new Error('Repository importer is unavailable.');
  }
}

void main().catch(() => { process.exitCode = 1; });
