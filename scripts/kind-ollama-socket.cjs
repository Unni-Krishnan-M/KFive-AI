#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '.kfive-owned';
const SOCKET = 'ollama.sock';

function mode(entry) { return entry.mode & 0o777; }

function inspectDirectory(directory, expectedUid) {
  const entry = fs.lstatSync(directory);
  if (entry.isSymbolicLink()) throw new Error(`${directory} must not be a symbolic link`);
  if (!entry.isDirectory()) throw new Error(`${directory} must be a directory`);
  if (entry.uid !== expectedUid) throw new Error(`${directory} must be owned by UID ${expectedUid}`);
  if (mode(entry) !== 0o700) throw new Error(`${directory} must have mode 0700`);
}

function inspectMarker(directory, expectedUid) {
  const markerPath = path.join(directory, MARKER);
  let entry;
  try { entry = fs.lstatSync(markerPath); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${directory} has no KFive identity marker`);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('KFive identity marker must be a regular file');
  if (entry.uid !== expectedUid || mode(entry) !== 0o600) throw new Error('KFive identity marker has unsafe ownership or mode');
  const identity = fs.readFileSync(markerPath, 'utf8').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity)) {
    throw new Error('KFive identity marker is invalid');
  }
  return identity;
}

function prepareSocketDirectory(directory, expectedUid) {
  if (!path.isAbsolute(directory)) throw new Error('Socket directory must be absolute');
  let entry;
  try { entry = fs.lstatSync(directory); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!entry) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, MARKER), `${crypto.randomUUID()}\n`, { flag: 'wx', mode: 0o600 });
  }
  inspectDirectory(directory, expectedUid);
  return inspectMarker(directory, expectedUid);
}

function verifySocket(directory, expectedUid) {
  inspectDirectory(directory, expectedUid);
  inspectMarker(directory, expectedUid);
  const socketPath = path.join(directory, SOCKET);
  const entry = fs.lstatSync(socketPath);
  if (!entry.isSocket() || entry.uid !== expectedUid || mode(entry) !== 0o660) {
    throw new Error('Ollama bridge socket must be an owned mode-0660 Unix socket');
  }
}

function cleanupSocketDirectory(directory, expectedUid) {
  let entry;
  try { entry = fs.lstatSync(directory); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error(`${directory} must not be a symbolic link`);
  inspectDirectory(directory, expectedUid);
  inspectMarker(directory, expectedUid);
  const entries = fs.readdirSync(directory);
  const unexpected = entries.filter((name) => name !== MARKER && name !== SOCKET);
  if (unexpected.length) throw new Error(`${directory} is not empty; refusing cleanup`);
  if (entries.includes(SOCKET)) {
    const socket = fs.lstatSync(path.join(directory, SOCKET));
    if (!socket.isSocket() || socket.uid !== expectedUid) throw new Error('Refusing to remove an unowned or non-socket entry');
    fs.unlinkSync(path.join(directory, SOCKET));
  }
  fs.unlinkSync(path.join(directory, MARKER));
  fs.rmdirSync(directory);
}

function inspectDockerOrphan(directory, overflowUid = 65534) {
  if (!path.isAbsolute(directory)) throw new Error('Socket directory must be absolute');
  const entry = fs.lstatSync(directory);
  if (entry.isSymbolicLink()) throw new Error(`${directory} must not be a symbolic link`);
  if (!entry.isDirectory()) throw new Error(`${directory} must be a directory`);
  if (entry.uid !== overflowUid || entry.gid !== overflowUid) {
    throw new Error(`${directory} must have overflow UID/GID ${overflowUid}`);
  }
  if (mode(entry) !== 0o755) throw new Error(`${directory} must have Docker-created mode 0755`);
  if (fs.readdirSync(directory).length !== 0) throw new Error(`${directory} must be empty`);
}

if (require.main === module) {
  const [command, directory, uidText] = process.argv.slice(2);
  const expectedUid = Number(uidText);
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) throw new Error('Expected UID must be a non-negative integer');
  if (command !== 'inspect-docker-orphan' && expectedUid < 1) {
    throw new Error('Expected runtime UID must be a positive integer');
  }
  if (command === 'prepare') prepareSocketDirectory(directory, expectedUid);
  else if (command === 'verify-socket') verifySocket(directory, expectedUid);
  else if (command === 'cleanup') cleanupSocketDirectory(directory, expectedUid);
  else if (command === 'inspect-docker-orphan') inspectDockerOrphan(directory, expectedUid);
  else throw new Error('Usage: kind-ollama-socket.cjs <prepare|verify-socket|cleanup|inspect-docker-orphan> <directory> <uid>');
}

module.exports = { cleanupSocketDirectory, inspectDockerOrphan, prepareSocketDirectory, verifySocket };
