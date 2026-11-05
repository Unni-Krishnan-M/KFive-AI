#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const yaml = require('js-yaml');

const [mode, repoURL, revision] = process.argv.slice(2);
if (!['projects', 'infrastructure', 'application'].includes(mode) || !repoURL || !revision) {
  process.stderr.write('Usage: render-gitops-bootstrap.cjs <projects|infrastructure|application> <repo-url> <revision>\n');
  process.exit(2);
}
if (!/^http:\/\/172\.(?:1[6-9]|2\d|3[01])\.[0-9]{1,3}\.[0-9]{1,3}:8080\/repo\.git$/.test(repoURL)) {
  throw new Error('The live Git source must be a private Docker-network IPv4 URL');
}
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Revision must be an exact Git SHA-1');

let resources;
if (mode === 'projects') {
  resources = yaml.loadAll(readFileSync('k8s/gitops/projects.yaml', 'utf8')).filter(Boolean);
  for (const resource of resources) resource.spec.sourceRepos = [repoURL];
} else {
  const resource = yaml.load(readFileSync(`k8s/gitops/${mode}-application.yaml`, 'utf8'));
  resource.spec.source.repoURL = repoURL;
  resource.spec.source.targetRevision = revision;
  resources = [resource];
}
process.stdout.write(resources.map((resource) => yaml.dump(resource, { noRefs: true, lineWidth: 120 })).join('---\n'));
