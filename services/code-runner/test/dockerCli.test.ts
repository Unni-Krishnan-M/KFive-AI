import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerOutputLimitError, ExecFileDockerAdapter } from '../src/dockerCli';

test('execFile adapter enforces a combined byte output limit without a shell', async () => {
  const adapter = new ExecFileDockerAdapter('/usr/bin/printf');

  await assert.rejects(
    adapter.run(['%s', 'x'.repeat(128)], { maxOutputBytes: 16 }),
    (error: unknown) => {
      assert.ok(error instanceof DockerOutputLimitError);
      assert.equal(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr), 16);
      return true;
    }
  );
});
