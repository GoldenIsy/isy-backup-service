import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../dist/config/load.js';
import { runBackup } from '../../dist/operations/backup.js';
import { executable, fixture, fakeRestic, secret, writeConfig } from '../helpers/fixture.mjs';

test('filesystem capture plus required target passes and publishes durable evidence', async () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.source, 'document.txt'), 'recoverable content');
    const restic = fakeRestic(value);
    const loaded = loadConfig(writeConfig(value, { tools: { restic } }));
    const receipt = await runBackup(loaded, new Date('2026-10-31T10:00:00.000Z'));
    assert.equal(receipt.result, 'PASS');
    assert.equal(receipt.sources[0].entries, 1);
    assert.equal(receipt.targets[0].snapshot_id, '0123456789abcdef');
    assert.equal(fs.existsSync(path.join(value.staging, receipt.backup_set_id)), false);
    const receiptFile = path.join(value.state, 'receipts', '2026-10-31', `${receipt.backup_set_id}.json`);
    assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), receipt);
    const journal = fs.readFileSync(path.join(value.state, 'journal', `${receipt.backup_set_id}.jsonl`), 'utf8');
    assert.match(journal, /"state":"PASS"/u);
  } finally { value.cleanup(); }
});

test('DST-002 optional target failure returns WARN, keeps required proof, and redacts diagnostics', async () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.source, 'document.txt'), 'recoverable content');
    const restic = fakeRestic(value);
    const providerToken = secret(value.root, 'provider-token', 'provider-super-secret');
    const targets = [
      { id: 'primary', type: 'filesystem', required: true, repository: path.join(value.root, 'repository-primary'), password_file: value.password, cache_directory: path.join(value.root, 'cache-primary') },
      { id: 'offsite', type: 'filesystem', required: false, repository: path.join(value.root, 'repository-fail'), password_file: value.password, cache_directory: path.join(value.root, 'cache-offsite'), environment_secret_files: { TEST_PROVIDER_TOKEN: providerToken } }
    ];
    const receipt = await runBackup(loadConfig(writeConfig(value, { tools: { restic }, targets })));
    assert.equal(receipt.result, 'WARN');
    assert.deepEqual(receipt.targets.map((target) => target.result), ['PASS', 'FAIL']);
    assert.doesNotMatch(JSON.stringify(receipt), /provider-super-secret/u);
    assert.match(receipt.findings[0].detail, /\[REDACTED\]/u);
    assert.equal(fs.existsSync(path.join(value.staging, receipt.backup_set_id)), false);
  } finally { value.cleanup(); }
});

test('DST-001 required target failure returns FAIL and retains staged recovery evidence', async () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.source, 'document.txt'), 'recoverable content');
    const restic = fakeRestic(value);
    const targets = [{ id: 'primary', type: 'filesystem', required: true, repository: path.join(value.root, 'repository-fail'), password_file: value.password, cache_directory: path.join(value.root, 'cache-primary') }];
    const receipt = await runBackup(loadConfig(writeConfig(value, { tools: { restic }, targets })));
    assert.equal(receipt.result, 'FAIL');
    assert.equal(receipt.targets[0].result, 'FAIL');
    assert.equal(fs.existsSync(path.join(value.staging, receipt.backup_set_id)), true);
    const status = JSON.parse(fs.readFileSync(path.join(value.state, 'status.json'), 'utf8'));
    assert.equal(status.last_success_at, null);
  } finally { value.cleanup(); }
});

test('MON-003 failed attempts preserve prior success and per-target freshness', async () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.source, 'document.txt'), 'recoverable content');
    const restic = fakeRestic(value);
    const passing = loadConfig(writeConfig(value, { tools: { restic } }));
    const success = await runBackup(passing, new Date('2026-10-31T08:00:00.000Z'));
    const targets = [{ id: 'primary', type: 'filesystem', required: true, repository: path.join(value.root, 'repository-fail'), password_file: value.password, cache_directory: path.join(value.root, 'cache-primary') }];
    const failure = await runBackup(loadConfig(writeConfig(value, { tools: { restic }, targets })), new Date('2026-10-31T09:00:00.000Z'));
    assert.equal(success.result, 'PASS');
    assert.equal(failure.result, 'FAIL');
    const status = JSON.parse(fs.readFileSync(path.join(value.state, 'status.json'), 'utf8'));
    assert.equal(status.last_attempt_at, failure.completed_at);
    assert.equal(status.last_success_at, success.completed_at);
    assert.equal(status.last_required_success_at, success.completed_at);
    assert.equal(status.target_freshness.primary, success.completed_at);
  } finally { value.cleanup(); }
});

test('MinIO/S3 capture uses rclone config by path and verifies copied objects', async () => {
  const value = fixture();
  try {
    const rcloneConfig = secret(value.root, 'rclone.conf', '[minio]\ntype = s3\nsecret_access_key = hidden-test-key');
    const argumentLog = path.join(value.root, 'rclone-arguments.jsonl');
    const rclone = executable(value.root, 'fake-rclone', `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argumentLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'copy') {
  fs.mkdirSync(args[2], {recursive:true});
  fs.writeFileSync(path.join(args[2], 'object.bin'), 'object-content');
}
`);
    const restic = fakeRestic(value);
    const sources = [{ id: 'objects', type: 's3', required: true, remote: 'minio:documents', config_file: rcloneConfig }];
    const receipt = await runBackup(loadConfig(writeConfig(value, { tools: { restic, rclone }, sources })));
    assert.equal(receipt.result, 'PASS');
    assert.equal(receipt.sources[0].entries, 1);
    const invocations = fs.readFileSync(argumentLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(invocations.map((args) => args[0]), ['copy', 'check']);
    assert.ok(invocations.every((args) => args.includes(rcloneConfig)));
    assert.doesNotMatch(JSON.stringify(invocations), /hidden-test-key/u);
  } finally { value.cleanup(); }
});

test('pCloud wiring gives Restic only the rclone config path and a separate repository password file', async () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.source, 'document.txt'), 'recoverable content');
    const rcloneConfig = secret(value.root, 'pcloud-rclone.conf', '[isy-pcloud]\ntype = pcloud\nhostname = eapi.pcloud.com\ntoken = hidden-oauth-value');
    const environmentLog = path.join(value.root, 'restic-environment.json');
    const restic = executable(value.root, 'fake-pcloud-restic', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(environmentLog)}, JSON.stringify({args, rcloneConfig:process.env.RCLONE_CONFIG, passwordFile:process.env.RESTIC_PASSWORD_FILE}));
const operation = args.find((arg) => ['backup','check'].includes(arg));
if (operation === 'backup') process.stdout.write(JSON.stringify({message_type:'summary',snapshot_id:'fedcba9876543210'}) + '\\n');
`);
    const targets = [{
      id: 'pcloud-eu', type: 'rclone', required: true,
      repository: 'rclone:isy-pcloud:Isyreport/Backups/restic',
      password_file: value.password,
      cache_directory: path.join(value.root, 'cache-pcloud'),
      environment_file_references: { RCLONE_CONFIG: rcloneConfig }
    }];
    const receipt = await runBackup(loadConfig(writeConfig(value, { tools: { restic }, targets })));
    assert.equal(receipt.result, 'PASS');
    const invocation = JSON.parse(fs.readFileSync(environmentLog, 'utf8'));
    assert.equal(invocation.rcloneConfig, rcloneConfig);
    assert.equal(invocation.passwordFile, value.password);
    assert.doesNotMatch(JSON.stringify(invocation.args), /hidden-oauth-value|test-restic-password/u);
  } finally { value.cleanup(); }
});

test('PostgreSQL capture uses a credential file, validates the dump, and records its checksum', async () => {
  const value = fixture();
  try {
    const pgpass = secret(value.root, 'pgpass', 'db.invalid:5432:application:backup:test-password');
    const argumentLog = path.join(value.root, 'pg-arguments.json');
    const pgDump = executable(value.root, 'fake-pg-dump', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argumentLog)}, JSON.stringify({args, pgpass: process.env.PGPASSFILE}));
fs.writeFileSync(args[args.indexOf('--file') + 1], 'valid-custom-dump');
`);
    const pgRestore = executable(value.root, 'fake-pg-restore', '#!/usr/bin/env node\nprocess.stdout.write("TABLE public documents owner\\n");\n');
    const restic = fakeRestic(value);
    const sources = [{ id: 'database', type: 'postgres', required: true, host: 'db.invalid', port: 5432, database: 'application', username: 'backup', password_file: pgpass }];
    const receipt = await runBackup(loadConfig(writeConfig(value, { tools: { restic, pg_dump: pgDump, pg_restore: pgRestore }, sources })));
    assert.equal(receipt.result, 'PASS');
    assert.equal(receipt.sources[0].bytes, 17);
    assert.match(receipt.sources[0].sha256, /^[a-f0-9]{64}$/u);
    const invocation = JSON.parse(fs.readFileSync(argumentLog, 'utf8'));
    assert.equal(invocation.pgpass, pgpass);
    assert.doesNotMatch(JSON.stringify(invocation.args), /test-password/u);
  } finally { value.cleanup(); }
});
