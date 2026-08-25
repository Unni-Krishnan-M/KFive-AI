import { RunnerValidationError, SupportedLanguage } from './types';

export interface RuntimeDefinition {
  language: SupportedLanguage;
  version: string;
  image: string;
  filename: 'main.py' | 'main.js';
  command: readonly string[];
  path: string;
}

const RUNTIMES: Readonly<Record<SupportedLanguage, RuntimeDefinition>> = Object.freeze({
  python: Object.freeze({
    language: 'python',
    version: '3.12',
    image: 'python:3.12-alpine',
    filename: 'main.py',
    command: Object.freeze(['python3', '-I', '-B', '/workspace/main.py']),
    path: '/usr/local/bin:/usr/bin:/bin',
  }),
  javascript: Object.freeze({
    language: 'javascript',
    version: '22',
    image: 'node:22-alpine',
    filename: 'main.js',
    command: Object.freeze([
      'node',
      '--permission',
      '--allow-fs-read=/workspace/main.js',
      '/workspace/main.js',
    ]),
    path: '/usr/local/bin:/usr/bin:/bin',
  }),
});

export function getRuntime(language: string): RuntimeDefinition {
  if (language !== 'python' && language !== 'javascript') {
    throw new RunnerValidationError(`Unsupported language '${language}'.`);
  }
  return RUNTIMES[language];
}

export function listRuntimes(): RuntimeDefinition[] {
  return [RUNTIMES.python, RUNTIMES.javascript];
}
