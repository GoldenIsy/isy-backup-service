import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { writeJsonAtomic } from '../../dist/runtime/atomic.js';
import { acquireLock } from '../../dist/runtime/lock.js';
import { runCommand } from '../../dist/runtime/process.js';
import { fixture, executable } from '../helpers/fixture.mjs';

test('atomic JSON publication leaves a complete owner-only file', () => {
  const value = fixture();
  try {
    const file = path.join(value.state, 'receipt.json');
    writeJsonAtomic(file, { result: 'PASS' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { result: 'PASS' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(value.state), ['receipt.json']);
  } finally { value.cleanup(); }
});

test('a second mutation lock fails closed', () => {
  const value = fixture();
  try {
    const release = acquireLock(value.state);
    assert.throws(() => acquireLock(value.state), /another mutation operation is active/u);
    release();
  } finally { value.cleanup(); }
});

test('bounded subprocess execution times out and does not use a shell', async () => {
  const value = fixture();
  try {
    const sleeper = executable(value.root, 'sleeper', '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n');
    await assert.rejects(runCommand(sleeper, ['$(touch should-not-exist)'], { timeoutMs: 30 }), /exceeded its deadline/u);
    assert.equal(fs.existsSync(path.join(value.root, 'should-not-exist')), false);
  } finally { value.cleanup(); }
});
