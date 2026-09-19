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
    command: Object.freeze(['python3', '-I', '-B', '-c',
      'import sys,base64,types; source=base64.b64decode("".join(sys.argv[1:])).decode("utf-8"); sys.argv=["/workspace/main.py"]; entry=types.ModuleType("__main__"); entry.__file__=sys.argv[0]; entry.__package__=None; sys.modules["__main__"]=entry; exec(compile(source, entry.__file__, "exec"), entry.__dict__)']),
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
      '-e',
      'const source = Buffer.from(process.argv.slice(1).join(""), "base64").toString("utf8"); process.argv = [process.execPath, "/workspace/main.js"]; const Module = require("node:module"); const entry = new Module("."); entry.filename = "/workspace/main.js"; process.mainModule = entry; Module._cache[entry.filename] = entry; entry._compile(source, entry.filename); entry.loaded = true;',
      '--',
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

/** Bounded ASCII arguments avoid shell interpolation and OS per-argument limits. */
export function sourceArguments(source: string): string[] {
  return Buffer.from(source, 'utf8').toString('base64').match(/.{1,32768}/g) ?? [];
}
