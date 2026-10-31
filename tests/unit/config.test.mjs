import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../dist/config/load.js';
import { fixture, writeConfig } from '../helpers/fixture.mjs';

test('CFG-001 admits an exact valid configuration without creating runtime state', () => {
  const value = fixture();
  try {
    const file = writeConfig(value);
    const loaded = loadConfig(file);
    assert.equal(loaded.config.deployment, 'test-deployment');
    assert.match(loaded.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(fs.existsSync(value.state), false);
    assert.equal(fs.existsSync(value.staging), false);
  } finally { value.cleanup(); }
});

test('CFG-001 rejects duplicate keys, unknown fields, and duplicate IDs before side effects', () => {
  const value = fixture();
  try {
    const duplicateKey = path.join(value.root, 'duplicate.yml');
    fs.writeFileSync(duplicateKey, `schema: isy.backup.config/v1\nschema: isy.backup.config/v1\n`);
    assert.throws(() => loadConfig(duplicateKey), /configuration YAML is invalid/u);

    const unknown = writeConfig(value, { unexpected: true });
    assert.throws(() => loadConfig(unknown), /must NOT have additional properties/u);

    const duplicateIds = writeConfig(value, {
      sources: [
        { id: 'same', type: 'filesystem', required: true, root: value.source },
        { id: 'same', type: 'filesystem', required: false, root: path.join(value.root, 'other-source') }
      ]
    });
    assert.throws(() => loadConfig(duplicateIds), /duplicate source id/u);
    assert.equal(fs.existsSync(value.state), false);
  } finally { value.cleanup(); }
});

test('SEC-001 rejects permissive secret files and credential-bearing repository URLs', () => {
  const value = fixture();
  try {
    fs.chmodSync(value.password, 0o644);
    assert.throws(() => loadConfig(writeConfig(value)), /must not be accessible by group or other users/u);
    fs.chmodSync(value.password, 0o600);
    const file = writeConfig(value, {
      targets: [{ id: 'remote', type: 's3', required: true, repository: 'https://user:password@example.invalid/repo', password_file: value.password, cache_directory: path.join(value.root, 'cache-remote') }]
    });
    assert.throws(() => loadConfig(file), /must not embed credentials/u);
  } finally { value.cleanup(); }
});

test('configuration identity is stable across YAML key ordering', () => {
  const value = fixture();
  try {
    const first = writeConfig(value);
    const firstHash = loadConfig(first).sha256;
    const parsed = JSON.parse(fs.readFileSync(first, 'utf8'));
    const reordered = path.join(value.root, 'reordered.yml');
    fs.writeFileSync(reordered, `${JSON.stringify({ targets: parsed.targets, sources: parsed.sources, staging_directory: parsed.staging_directory, state_directory: parsed.state_directory, environment: parsed.environment, deployment: parsed.deployment, schema: parsed.schema }, null, 2)}\n`);
    assert.equal(loadConfig(reordered).sha256, firstHash);
  } finally { value.cleanup(); }
});
