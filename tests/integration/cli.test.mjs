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
