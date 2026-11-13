import {
  validateRepositoryImporterSocketPath,
} from './services/repositoryImporterClient';
import { REPOSITORY_IMPORTER_SOCKET_PATH } from './services/repositoryArchiveIsolationProtocol';
import { startRepositoryImporterServer } from './services/repositoryImporterServer';

async function main(): Promise<void> {
  const configured = validateRepositoryImporterSocketPath(process.env.REPOSITORY_IMPORTER_SOCKET_PATH || '');
  if (configured !== REPOSITORY_IMPORTER_SOCKET_PATH) throw new Error('Repository importer requires the fixed socket path.');
  const uid = process.getuid?.(); const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('Repository importer requires Unix credentials.');
  const importer = await startRepositoryImporterServer({
    socketPath: configured,
    expectedUid: uid,
    expectedGid: gid,
    parentMode: 0o770,
  });
  process.stdout.write(`${JSON.stringify({ service: 'repository-importer', transport: 'unix-socket', ready: true })}\n`);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return; shuttingDown = true;
    void importer.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void main().catch(() => {
  process.stderr.write('Repository importer failed to start safely.\n');
  process.exitCode = 1;
});
