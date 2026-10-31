import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isy-backup-test-'));
  const source = path.join(root, 'source');
  const state = path.join(root, 'state');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(source, { recursive: true });
  const password = secret(root, 'restic-password', 'test-restic-password');
  return {
    root,
    source,
    state,
    staging,
    password,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

export function secret(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function executable(root, name, source) {
  const file = path.join(root, name);
  fs.writeFileSync(file, source, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

export function writeConfig(fixtureValue, overrides = {}) {
  const value = {
    schema: 'isy.backup.config/v1',
    deployment: 'test-deployment',
    environment: 'test',
    state_directory: fixtureValue.state,
    staging_directory: fixtureValue.staging,
    sources: [{ id: 'files', type: 'filesystem', required: true, root: fixtureValue.source }],
    targets: [{
      id: 'primary',
      type: 'filesystem',
      required: true,
      repository: path.join(fixtureValue.root, 'repository'),
      password_file: fixtureValue.password,
      cache_directory: path.join(fixtureValue.root, 'cache-primary')
    }],
    ...overrides
  };
  const file = path.join(fixtureValue.root, 'config.yml');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export function fakeRestic(fixtureValue) {
  return executable(fixtureValue.root, 'fake-restic', `#!/usr/bin/env node
const args = process.argv.slice(2);
const repo = args[args.indexOf('--repo') + 1];
const operation = args.find((arg) => ['init', 'backup', 'check', 'snapshots', 'restore'].includes(arg));
if (repo.includes('fail') && operation === 'backup') {
  process.stderr.write('token=' + String(process.env.TEST_PROVIDER_TOKEN) + '\\n');
  process.exit(17);
}
if (operation === 'backup') process.stdout.write(JSON.stringify({message_type:'summary', snapshot_id:'0123456789abcdef'}) + '\\n');
if (operation === 'snapshots') process.stdout.write(JSON.stringify([{id:'0123456789abcdef'}]) + '\\n');
if (operation === 'restore') {
  const output = args[args.indexOf('--target') + 1];
  require('node:fs').writeFileSync(require('node:path').join(output, 'restored'), 'ok');
}
`);
}
