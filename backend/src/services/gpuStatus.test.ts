import { CommandRunner, getGpuStatus } from './gpuStatus';

describe('getGpuStatus', () => {
  it('probes nvidia-smi with an argument array and normalizes GPU metrics', async () => {
    const runner = jest.fn<ReturnType<CommandRunner>, Parameters<CommandRunner>>().mockResolvedValue({
      stdout: '0, NVIDIA RTX 5070 Laptop GPU, GPU-abc, 580.10, 8192, 1024, 37, 55\n',
      stderr: '',
    });

    const status = await getGpuStatus(runner);

    expect(runner).toHaveBeenCalledWith(
      'nvidia-smi',
      [expect.stringContaining('--query-gpu=index,name,uuid'), '--format=csv,noheader,nounits'],
      { timeout: 3000, maxBuffer: 262144, windowsHide: true }
    );
    expect(status).toMatchObject({
      available: true,
      gpus: [{
        index: 0,
        name: 'NVIDIA RTX 5070 Laptop GPU',
        memoryTotalMiB: 8192,
        memoryUsedMiB: 1024,
        memoryFreeMiB: 7168,
        utilizationPercent: 37,
        temperatureC: 55,
      }],
      summary: { deviceCount: 1, totalVramMiB: 8192, usedVramMiB: 1024, freeVramMiB: 7168 },
    });
  });

  it('reports a missing executable without assuming GPU access', async () => {
    const runner: CommandRunner = async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    await expect(getGpuStatus(runner)).resolves.toMatchObject({
      available: false,
      reason: 'nvidia-smi-not-found',
      gpus: [],
    });
  });

  it('reports timeouts and malformed output explicitly', async () => {
    const timeoutRunner: CommandRunner = async () => {
      throw Object.assign(new Error('timeout'), { killed: true });
    };
    await expect(getGpuStatus(timeoutRunner)).resolves.toMatchObject({ available: false, reason: 'probe-timeout' });

    const malformedRunner: CommandRunner = async () => ({ stdout: 'unexpected', stderr: '' });
    await expect(getGpuStatus(malformedRunner)).resolves.toMatchObject({ available: false, reason: 'malformed-output' });
  });
});

