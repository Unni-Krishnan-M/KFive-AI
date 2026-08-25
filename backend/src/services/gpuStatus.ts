import { execFile } from 'child_process';

export type GpuUnavailableReason =
  | 'nvidia-smi-not-found'
  | 'probe-timeout'
  | 'driver-unavailable'
  | 'malformed-output'
  | 'no-nvidia-gpu';

export interface GpuDeviceStatus {
  index: number;
  name: string;
  uuid: string;
  driverVersion: string;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  memoryFreeMiB: number;
  utilizationPercent: number;
  temperatureC: number;
}

export interface GpuStatus {
  available: boolean;
  reason?: GpuUnavailableReason;
  message: string;
  gpus: GpuDeviceStatus[];
  summary?: {
    deviceCount: number;
    totalVramMiB: number;
    usedVramMiB: number;
    freeVramMiB: number;
  };
  sampledAt: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean }
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error) {
      reject(Object.assign(error, { stdout, stderr }));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const QUERY_FIELDS = [
  'index',
  'name',
  'uuid',
  'driver_version',
  'memory.total',
  'memory.used',
  'utilization.gpu',
  'temperature.gpu',
] as const;

function unavailable(reason: GpuUnavailableReason, message: string): GpuStatus {
  return { available: false, reason, message, gpus: [], sampledAt: new Date().toISOString() };
}

function parseNumber(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function getGpuStatus(runner: CommandRunner = runCommand): Promise<GpuStatus> {
  try {
    const result = await runner('nvidia-smi', [
      `--query-gpu=${QUERY_FIELDS.join(',')}`,
      '--format=csv,noheader,nounits',
    ], { timeout: 3_000, maxBuffer: 256 * 1024, windowsHide: true });
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return unavailable('no-nvidia-gpu', 'nvidia-smi reported no NVIDIA GPU devices.');

    const gpus: GpuDeviceStatus[] = [];
    for (const line of lines) {
      const fields = line.split(',').map((field) => field.trim());
      if (fields.length !== QUERY_FIELDS.length) {
        return unavailable('malformed-output', 'nvidia-smi returned an unexpected response.');
      }
      const [index, name, uuid, driverVersion, total, used, utilization, temperature] = fields;
      const numeric = [index, total, used, utilization, temperature].map(parseNumber);
      if (numeric.some((value) => value === undefined) || !name || !uuid || !driverVersion) {
        return unavailable('malformed-output', 'nvidia-smi returned incomplete GPU metrics.');
      }
      const [parsedIndex, parsedTotal, parsedUsed, parsedUtilization, parsedTemperature] = numeric as number[];
      gpus.push({
        index: parsedIndex,
        name,
        uuid,
        driverVersion,
        memoryTotalMiB: parsedTotal,
        memoryUsedMiB: parsedUsed,
        memoryFreeMiB: Math.max(0, parsedTotal - parsedUsed),
        utilizationPercent: parsedUtilization,
        temperatureC: parsedTemperature,
      });
    }

    const summary = gpus.reduce((value, gpu) => ({
      deviceCount: value.deviceCount + 1,
      totalVramMiB: value.totalVramMiB + gpu.memoryTotalMiB,
      usedVramMiB: value.usedVramMiB + gpu.memoryUsedMiB,
      freeVramMiB: value.freeVramMiB + gpu.memoryFreeMiB,
    }), { deviceCount: 0, totalVramMiB: 0, usedVramMiB: 0, freeVramMiB: 0 });

    return {
      available: true,
      message: `${gpus.length} NVIDIA GPU device${gpus.length === 1 ? '' : 's'} available.`,
      gpus,
      summary,
      sampledAt: new Date().toISOString(),
    };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string };
    if (commandError.code === 'ENOENT') {
      return unavailable('nvidia-smi-not-found', 'nvidia-smi is not installed or is not available to the backend process.');
    }
    if (commandError.killed || commandError.signal === 'SIGTERM' || commandError.code === 'ETIMEDOUT') {
      return unavailable('probe-timeout', 'The NVIDIA GPU probe timed out.');
    }
    return unavailable(
      'driver-unavailable',
      commandError.stderr?.trim() || 'nvidia-smi could not communicate with an NVIDIA driver or GPU.'
    );
  }
}

