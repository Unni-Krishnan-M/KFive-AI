#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._/:~-]*@sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const SAFE_PASSWORD = /^[A-Za-z0-9._~-]+$/;
const PLACEHOLDER = /change|example|placeholder|replace|your[-_]?|secret/i;
const ALLOWED_KEYS = new Set([
  'KFIVE_PRODUCTION_PROJECT', 'KFIVE_VOLUME_PREFIX', 'KFIVE_EDGE_BIND_ADDRESS', 'KFIVE_EDGE_HTTP_PORT',
  'KFIVE_MODE', 'PUBLIC_BASE_URL', 'CORS_ORIGIN', 'AI_PROVIDER', 'AI_DEFAULT_MODEL', 'AI_EMBEDDING_MODEL',
  'TRUST_PROXY_HOPS',
  'AI_MAX_OUTPUT_TOKENS', 'AI_TIMEOUT_MS', 'OPENAI_BASE_URL', 'OPENAI_API_KEY',
  'OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS', 'OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_API_KEY',
  'CUSTOM_LLM_SUPPORTS_EMBEDDINGS', 'CUSTOM_LLM_SUPPORTS_STRUCTURED_OUTPUT',
  'MONGO_ROOT_USERNAME', 'MONGO_ROOT_PASSWORD', 'MONGO_DATABASE', 'MONGO_APP_USERNAME', 'MONGO_APP_PASSWORD',
  'REDIS_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN', 'QUEUE_CONCURRENCY',
  'KFIVE_BACKEND_IMAGE', 'KFIVE_FRONTEND_IMAGE', 'KFIVE_MONGODB_IMAGE', 'KFIVE_REDIS_IMAGE', 'KFIVE_CHROMADB_IMAGE',
]);

function parseEnvironmentFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Production environment must be a regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('Production environment must not be group- or world-accessible');
  const result = {};
  for (const [index, rawLine] of fs.readFileSync(resolved, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line !== rawLine || /["'`\\$\s\x00-\x1f\x7f]/.test(line)) {
      throw new Error(`Production environment line ${index + 1} uses unsupported quoting, interpolation, escaping, whitespace, or control characters`);
    }
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Invalid production environment line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || Object.hasOwn(result, key)) {
      throw new Error(`Invalid or duplicate production environment key on line ${index + 1}`);
    }
    const value = line.slice(separator + 1);
    result[key] = value;
  }
  return result;
}

function required(environment, key) {
  const value = environment[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function httpsUrl(environment, key, { originOnly = false } = {}) {
  const raw = required(environment, key);
  let value;
  try { value = new URL(raw); } catch { throw new Error(`${key} must be a valid HTTPS URL`); }
  if (value.protocol !== 'https:' || value.username || value.password || value.hash) {
    throw new Error(`${key} must be HTTPS without credentials or a fragment`);
  }
  if (originOnly && (value.origin !== raw.replace(/\/$/, '') || (value.pathname !== '/' && value.pathname !== ''))) {
    throw new Error(`${key} must be an HTTPS origin without a path, query, or fragment`);
  }
  return value;
}

function strongSecret(environment, key) {
  const value = required(environment, key);
  if (value.length < 32 || !/^[A-Za-z0-9_-]+$/.test(value) || new Set(value).size < 12 || PLACEHOLDER.test(value)) {
    throw new Error(`${key} must be a diverse base64url value of at least 32 characters`);
  }
  return value;
}

function boundedDuration(environment, key, fallback, minSeconds, maxSeconds) {
  const value = environment[key] || fallback;
  const match = /^([1-9]\d*)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`${key} must use canonical integer s/m/h/d syntax`);
  const factors = {s: 1, m: 60, h: 3600, d: 86400};
  const seconds = Number(match[1]) * factors[match[2]];
  if (!Number.isSafeInteger(seconds) || seconds < minSeconds || seconds > maxSeconds) {
    throw new Error(`${key} is outside the allowed lifetime range`);
  }
  return value;
}

function validateProductionEnvironment(environment) {
  for (const key of Object.keys(environment)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`${key} is not an allowed production environment key`);
  }
  for (const key of ['KFIVE_PRODUCTION_PROJECT', 'KFIVE_VOLUME_PREFIX']) {
    if (!SAFE_IDENTIFIER.test(required(environment, key))) throw new Error(`${key} contains unsupported characters`);
  }
  if (required(environment, 'KFIVE_EDGE_BIND_ADDRESS') !== '127.0.0.1') {
    throw new Error('KFIVE_EDGE_BIND_ADDRESS must be 127.0.0.1; terminate TLS before the loopback listener');
  }
  const edgePort = Number(required(environment, 'KFIVE_EDGE_HTTP_PORT'));
  if (!Number.isInteger(edgePort) || edgePort < 1024 || edgePort > 65535) {
    throw new Error('KFIVE_EDGE_HTTP_PORT must be an unprivileged TCP port');
  }
  const mode = required(environment, 'KFIVE_MODE');
  if (mode !== 'remote' && mode !== 'hybrid') throw new Error('KFIVE_MODE must be remote or hybrid');
  if (required(environment, 'TRUST_PROXY_HOPS') !== '2') {
    throw new Error('TRUST_PROXY_HOPS must be 2 for TLS proxy -> frontend -> backend');
  }

  const publicUrl = httpsUrl(environment, 'PUBLIC_BASE_URL', { originOnly: true });
  const corsOrigins = required(environment, 'CORS_ORIGIN').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (corsOrigins.length === 0 || !corsOrigins.includes(publicUrl.origin)) {
    throw new Error('CORS_ORIGIN must contain PUBLIC_BASE_URL');
  }
  for (const origin of corsOrigins) httpsUrl({ ORIGIN: origin }, 'ORIGIN', { originOnly: true });

  const provider = required(environment, 'AI_PROVIDER');
  const providerConfiguration = {
    openai: ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
    'openai-compatible': ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    custom: ['CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_API_KEY'],
  }[provider];
  if (!providerConfiguration) throw new Error('AI_PROVIDER must be an authenticated remote provider');
  httpsUrl(environment, providerConfiguration[0]);
  const providerKey = required(environment, providerConfiguration[1]);
  if (providerKey.length < 16 || PLACEHOLDER.test(providerKey)) throw new Error(`${providerConfiguration[1]} must be a non-placeholder credential`);
  required(environment, 'AI_DEFAULT_MODEL');

  const jwtSecret = strongSecret(environment, 'JWT_SECRET');
  const refreshSecret = strongSecret(environment, 'JWT_REFRESH_SECRET');
  if (jwtSecret === refreshSecret) throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be distinct');
  boundedDuration(environment, 'JWT_EXPIRES_IN', '15m', 1, 24 * 60 * 60);
  boundedDuration(environment, 'JWT_REFRESH_EXPIRES_IN', '7d', 60, 30 * 24 * 60 * 60);

  for (const key of ['MONGO_ROOT_USERNAME', 'MONGO_APP_USERNAME', 'MONGO_DATABASE']) {
    if (!SAFE_IDENTIFIER.test(required(environment, key))) throw new Error(`${key} contains unsupported characters`);
  }
  if (environment.MONGO_ROOT_USERNAME === environment.MONGO_APP_USERNAME) throw new Error('Mongo root and application usernames must be distinct');
  for (const key of ['MONGO_ROOT_PASSWORD', 'MONGO_APP_PASSWORD', 'REDIS_PASSWORD']) {
    const password = required(environment, key);
    if (password.length < 20 || !SAFE_PASSWORD.test(password) || PLACEHOLDER.test(password)) {
      throw new Error(`${key} must be at least 20 URL-safe non-placeholder characters`);
    }
  }
  if (environment.MONGO_ROOT_PASSWORD === environment.MONGO_APP_PASSWORD) throw new Error('Mongo root and application passwords must be distinct');
  for (const key of ['KFIVE_BACKEND_IMAGE', 'KFIVE_FRONTEND_IMAGE', 'KFIVE_MONGODB_IMAGE', 'KFIVE_REDIS_IMAGE', 'KFIVE_CHROMADB_IMAGE']) {
    const image = required(environment, key);
    if (!IMAGE_DIGEST.test(image) || /@sha256:([a-f0-9])\1{63}$/.test(image)) throw new Error(`${key} must be pinned by a real sha256 digest`);
  }
  return { mode, provider, publicOrigin: publicUrl.origin };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--env-file') {
    process.stderr.write('Usage: production-environment.cjs --env-file <path>\n');
    process.exit(2);
  }
  try {
    const summary = validateProductionEnvironment(parseEnvironmentFile(args[1]));
    process.stdout.write(`Validated KFive ${summary.mode} production configuration for ${summary.publicOrigin}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = { parseEnvironmentFile, validateProductionEnvironment };
