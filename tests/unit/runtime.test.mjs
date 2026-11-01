import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { doctor } from '../../dist/operations/doctor.js';
import { writeJsonAtomic } from '../../dist/runtime/atomic.js';
import { acquireLock, recoverStaleMutationLock } from '../../dist/runtime/lock.js';
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

test('recent mutation locks cannot be stolen during service recovery', () => {
  const value = fixture();
  try {
    const release = acquireLock(value.state, 'active-backup');
    assert.throws(
      () => recoverStaleMutationLock(value.state, new Date(Date.now() + 60_000), 5 * 60_000),
      /refusing unsafe automatic recovery/u
    );
    assert.equal(fs.existsSync(path.join(value.state, 'locks', 'mutation.lock')), true);
    release();
  } finally { value.cleanup(); }
});

test('an expired mutation lease is recovered without widening the target', () => {
  const value = fixture();
  try {
    const locks = path.join(value.state, 'locks');
    fs.mkdirSync(locks, { recursive: true });
    const lock = path.join(locks, 'mutation.lock');
    fs.writeFileSync(lock, 'legacy interrupted lease\n', { mode: 0o600 });
    const old = new Date('2026-10-01T00:00:00.000Z');
    fs.utimesSync(lock, old, old);
    assert.equal(recoverStaleMutationLock(value.state, new Date('2026-11-01T00:00:00.000Z'), 24 * 60 * 60 * 1_000), true);
    assert.equal(fs.existsSync(lock), false);
    assert.deepEqual(fs.readdirSync(locks), []);
  } finally { value.cleanup(); }
});

test('mutation recovery reports absence and applies the stale boundary exactly', () => {
  const value = fixture();
  try {
    assert.equal(recoverStaleMutationLock(value.state, new Date(), 1000), false);
    const release = acquireLock(value.state, 'boundary-test');
    const lock = path.join(value.state, 'locks', 'mutation.lock');
    const modified = fs.statSync(lock).mtimeMs;
    assert.throws(() => recoverStaleMutationLock(value.state, new Date(modified + 999), 1000), /recent mutation lock/u);
    release();
    release();

    const secondRelease = acquireLock(value.state, 'exact-boundary-test');
    const secondLock = path.join(value.state, 'locks', 'mutation.lock');
    const secondModified = fs.statSync(secondLock).mtimeMs;
    assert.equal(recoverStaleMutationLock(value.state, new Date(secondModified + 1001), 1000), true);
    assert.throws(secondRelease, /ownership changed/u);
  } finally { value.cleanup(); }
});

test('mutation release refuses to delete a lock whose ownership changed', () => {
  const value = fixture();
  try {
    const release = acquireLock(value.state, 'ownership-test');
    const lock = path.join(value.state, 'locks', 'mutation.lock');
    const stolen = JSON.parse(fs.readFileSync(lock, 'utf8'));
    stolen.lease_id = 'different-owner';
    fs.writeFileSync(lock, `${JSON.stringify(stolen)}\n`, { mode: 0o600 });
    assert.throws(release, /ownership changed/u);
    assert.equal(fs.existsSync(lock), true);
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

test('dependency doctor uses each tool native version invocation', async () => {
  const value = fixture();
  try {
    const calls = path.join(value.root, 'version-calls');
    const tool = (name) => executable(value.root, name, `#!/usr/bin/env node
require('node:fs').appendFileSync('${calls}', '${name} ' + process.argv.slice(2).join(' ') + '\\n');
process.stdout.write('${name} test-version\\n');
`);
    const result = await doctor({
      state_directory: value.state,
      staging_directory: value.staging,
      sources: [
        { id: 'database', type: 'postgres' },
        { id: 'objects', type: 's3' }
      ],
      tools: {
        restic: tool('restic'),
        pg_dump: tool('pg_dump'),
        pg_restore: tool('pg_restore'),
        rclone: tool('rclone')
      }
    });

    assert.equal(result.result, 'PASS');
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
      'restic version',
      'pg_dump --version',
      'pg_restore --version',
      'rclone version'
    ]);
  } finally { value.cleanup(); }
});
