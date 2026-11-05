'use strict';

function percentile(samples, fraction) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('samples must be non-empty');
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new Error('percentile fraction must be within (0, 1]');
  if (!samples.every((value) => Number.isFinite(value) && value >= 0)) throw new Error('samples must be finite non-negative numbers');
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function parsePrometheusSample(body, exactSample, options = {}) {
  if (typeof body !== 'string' || typeof exactSample !== 'string' || !exactSample) throw new Error('metric input must be strings');
  const matches = body.split(/\r?\n/).filter((line) => line.startsWith(`${exactSample} `));
  if (matches.length === 0 && Object.hasOwn(options, 'absentValue')) return options.absentValue;
  if (matches.length === 0) throw new Error('metric sample is absent');
  if (matches.length > 1) throw new Error('duplicate metric sample');
  const value = Number(matches[0].slice(exactSample.length + 1));
  if (!Number.isFinite(value)) throw new Error('metric sample must be finite');
  return value;
}

async function runBounded(inputs, concurrency, worker) {
  if (!Array.isArray(inputs)) throw new Error('inputs must be an array');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  if (typeof worker !== 'function') throw new Error('worker must be a function');
  const results = new Array(inputs.length);
  let cursor = 0;
  async function consume() {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(inputs[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, consume));
  return results;
}

function parseDockerByteSize(value) {
  const match = /^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/.exec(value);
  if (!match) throw new Error('invalid Docker byte size');
  const multipliers = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  const bytes = Number(match[1]) * multipliers[match[2]];
  if (!Number.isFinite(bytes)) throw new Error('invalid Docker byte size');
  return bytes;
}

function stripAnsiControls(value) {
  if (typeof value !== 'string') throw new Error('ANSI input must be a string');
  return value.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

module.exports = { parseDockerByteSize, percentile, parsePrometheusSample, runBounded, stripAnsiControls };
