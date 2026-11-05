#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const [operation, clusterName] = process.argv.slice(2);
const root = '/tmp/kfive-kind-gitops';

if (operation !== 'cleanup' || clusterName !== 'kfive') {
  process.stderr.write('Usage: kind-gitops-source.cjs cleanup kfive\n');
  process.exit(2);
}
if (!fs.existsSync(root)) process.exit(0);
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid()) {
  throw new Error('Refusing unsafe GitOps root cleanup');
}
const markerPath = path.join(root, '.kfive-owned');
const markerStat = fs.lstatSync(markerPath);
if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== process.getuid()
    || fs.readFileSync(markerPath, 'utf8').trim() !== clusterName) {
  throw new Error('Refusing foreign GitOps root cleanup');
}
fs.rmSync(root, { recursive: true, force: false, maxRetries: 2 });
