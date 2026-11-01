import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { aggregateResult } from '../../dist/domain/results.js';
import { createRedactor, credentialValuesFromText } from '../../dist/security/redact.js';
import { validateRestoreOutput } from '../../dist/operations/restore.js';
import { runRestore } from '../../dist/operations/restore.js';
import { fixture, writeConfig } from '../helpers/fixture.mjs';
import { loadConfig } from '../../dist/config/load.js';

function source(required, result) {
  return { id: 'source', type: 'filesystem', required, result, artifact: null, sha256: null, bytes: 0 };
}

function target(required, result) {
  return { id: 'target', type: 'filesystem', required, result, snapshot_id: null, verification: 'NONE' };
}

test('DST-001 and DST-002 aggregate required and optional results without false success', () => {
  for (const sourceResult of ['PASS', 'WARN', 'FAIL']) {
    for (const targetResult of ['PASS', 'WARN', 'FAIL']) {
      const result = aggregateResult([source(true, sourceResult)], [target(true, targetResult)]);
      assert.equal(result, sourceResult === 'PASS' && targetResult === 'PASS' ? 'PASS' : 'FAIL');
    }
  }
  assert.equal(aggregateResult([source(true, 'PASS')], [target(false, 'FAIL')]), 'WARN');
  assert.equal(aggregateResult([source(true, 'PASS')], [target(false, 'WARN')]), 'WARN');
});

test('SEC-002 redacts supplied secrets, credential fields, and URL passwords', () => {
  const secret = 'hostile-test-token-123';
  const redact = createRedactor([secret]);
  const result = redact(`token=${secret} authorization: bearer-value https://name:url-password@example.invalid ${secret}`);
  assert.doesNotMatch(result, /hostile-test-token-123|bearer-value|url-password/u);
  assert.match(result, /\[REDACTED\]/u);
});

test('SEC-002 extracts token values from provider configuration for redaction', () => {
  const config = '[remote]\ntype = pcloud\ntoken = encoded-provider-token\n';
  const redact = createRedactor(credentialValuesFromText(config));
  assert.equal(redact('provider rejected encoded-provider-token'), 'provider rejected [REDACTED]');
});

test('SEC-002 redacts credential spelling variants and bounds diagnostic output', () => {
  const redact = createRedactor(['abc', 'a much longer secret']);
  const output = redact([
    'password=visible', 'passwd:visible', 'access_key=visible',
    'access-key:visible', 'http://name:visible@example.invalid',
    'https://name:visible@example.invalid', 'a much longer secret', 'x'.repeat(5000)
  ].join(' '));
  assert.doesNotMatch(output, /visible|much longer secret/u);
  assert.equal(output.length, 4096);
});

test('RST-002 blocks restore overlap and permits a new isolated directory', () => {
  const value = fixture();
  try {
    const config = loadConfig(writeConfig(value)).config;
    assert.throws(() => validateRestoreOutput(config, path.join(value.source, 'restore')), /overlaps a protected/u);
    assert.throws(() => validateRestoreOutput(config, value.state), /overlaps a protected/u);
    assert.throws(() => validateRestoreOutput(config, config.targets[0].repository), /overlaps a protected/u);
    assert.throws(() => validateRestoreOutput(config, 'relative-output'), /must be absolute/u);
    const occupied = path.join(value.root, 'occupied-restore');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'existing'), 'preserve me');
    assert.throws(() => validateRestoreOutput(config, occupied), /absent or empty/u);
    assert.equal(fs.readFileSync(path.join(occupied, 'existing'), 'utf8'), 'preserve me');
    const safe = path.join(value.root, 'isolated-restore');
    assert.equal(validateRestoreOutput(config, safe), safe);
    assert.equal(fs.statSync(safe).mode & 0o777, 0o700);
  } finally { value.cleanup(); }
});

test('restore rejects the moving latest alias before creating output', async () => {
  const value = fixture();
  try {
    const config = loadConfig(writeConfig(value)).config;
    const output = path.join(value.root, 'latest-restore');
    await assert.rejects(runRestore(config, config.targets[0], 'latest', output), /immutable snapshot identity/u);
    await assert.rejects(runRestore(config, config.targets[0], '01234567trailing', output), /immutable snapshot identity/u);
    await assert.rejects(runRestore(config, config.targets[0], 'x01234567', output), /immutable snapshot identity/u);
    assert.equal(fs.existsSync(output), false);
  } finally { value.cleanup(); }
});
