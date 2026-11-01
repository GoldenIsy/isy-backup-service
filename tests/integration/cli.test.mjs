import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fixture, fakeRestic, writeConfig } from '../helpers/fixture.mjs';

const cli = path.resolve('dist/cli/main.js');

function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('CLI validates configuration and performs repository lifecycle commands', () => {
  const value = fixture();
  try {
    const restic = fakeRestic(value);
    const config = writeConfig(value, { tools: { restic } });
    for (const command of [
      ['config', 'validate', '--config', config],
      ['repository', 'init', '--config', config, '--target', 'primary'],
      ['check', '--config', config, '--target', 'primary'],
      ['snapshots', '--config', config, '--target', 'primary']
    ]) {
      const result = invoke(command);
      assert.equal(result.status, 0, `${command.join(' ')} failed: ${result.stdout} ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).result ?? 'PASS', 'PASS');
    }
  } finally { value.cleanup(); }
});

test('CLI exports a complete deployment bundle without overwriting it', () => {
  const value = fixture();
  try {
    const output = path.join(value.root, 'deployment');
    const result = invoke(['deployment', 'export', '--output', output]);
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).files, [
      'compose.yml',
      'config.yml',
      'providers/pcloud-eu.example.yml',
      'README.md',
      'scripts/put-secret.sh'
    ]);
    assert.equal(fs.statSync(path.join(output, 'scripts/put-secret.sh')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(output, 'secrets')).mode & 0o777, 0o700);

    const repeated = invoke(['deployment', 'export', '--output', output]);
    assert.equal(repeated.status, 2);
    assert.equal(JSON.parse(repeated.stdout).code, 'DEPLOYMENT_EXPORT_EXISTS');
  } finally { value.cleanup(); }
});

test('CLI restore writes only to an isolated empty output', () => {
  const value = fixture();
  try {
    const restic = fakeRestic(value);
    const config = writeConfig(value, { tools: { restic } });
    const output = path.join(value.root, 'restore-output');
    const result = invoke(['restore', '--config', config, '--target', 'primary', '--snapshot', '0123456789abcdef', '--output', output]);
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    assert.equal(fs.readFileSync(path.join(output, 'restored'), 'utf8'), 'ok');
    const collision = invoke(['restore', '--config', config, '--target', 'primary', '--snapshot', '0123456789abcdef', '--output', value.source]);
    assert.equal(collision.status, 6);
    assert.equal(JSON.parse(collision.stdout).code, 'RESTORE_TARGET_COLLISION');
  } finally { value.cleanup(); }
});

test('CLI deletes only an immutable snapshot with exact confirmation and prune', () => {
  const value = fixture();
  try {
    const restic = fakeRestic(value);
    const config = writeConfig(value, { tools: { restic } });
    const snapshot = '0123456789abcdef';
    const rejected = invoke(['forget', '--config', config, '--target', 'primary', '--snapshot', snapshot, '--confirm-delete', 'different']);
    assert.equal(rejected.status, 2);
    assert.equal(fs.existsSync(path.join(value.root, 'forgotten-snapshot')), false);

    const result = invoke(['forget', '--config', config, '--target', 'primary', '--snapshot', snapshot, '--confirm-delete', snapshot]);
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    const args = fs.readFileSync(path.join(value.root, 'forgotten-snapshot'), 'utf8').split('\n');
    assert.deepEqual(args.slice(-3), ['forget', snapshot, '--prune']);
  } finally { value.cleanup(); }
});

test('CLI applies configured retention and writes a separate receipt', () => {
  const value = fixture();
  try {
    const restic = fakeRestic(value);
    const config = writeConfig(value, {
      tools: { restic },
      targets: [{
        id: 'primary', type: 'filesystem', required: true,
        repository: path.join(value.root, 'repository'), password_file: value.password,
        cache_directory: path.join(value.root, 'cache-primary'),
        retention: { keep_daily: 7, keep_weekly: 4, keep_monthly: 12 }
      }]
    });
    const result = invoke(['retention', '--config', config, '--target', 'primary']);
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.result, 'PASS');
    assert.equal(receipt.operation, 'retention');
    assert.ok(fs.existsSync(path.join(value.state, 'retention', `${receipt.operation_id}.json`)));
    const args = fs.readFileSync(path.join(value.root, 'forgotten-snapshot'), 'utf8').split('\n');
    assert.deepEqual(args.slice(-10), ['forget', '--prune', '--group-by', '', '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '12']);
  } finally { value.cleanup(); }
});
