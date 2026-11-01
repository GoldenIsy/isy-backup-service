import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('runtime image carries the PostgreSQL 16 client required by supported deployments', () => {
  const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /ARG POSTGRES_CLIENT_VERSION=16\./u);
  assert.match(dockerfile, /postgresql-client-16=\$\{POSTGRES_CLIENT_VERSION\}/u);
  assert.doesNotMatch(dockerfile, /postgresql-client-15/u);
});

test('Compose exposes only the narrow control socket volume with hardened backup runtime', () => {
  const compose = parse(fs.readFileSync(new URL('../../compose.example.yml', import.meta.url), 'utf8'));
  const backup = compose.services.backup;
  assert.equal(backup.user, '1000:1000');
  assert.equal(backup.read_only, true);
  assert.deepEqual(backup.cap_drop, ['ALL']);
  assert.ok(backup.security_opt.includes('no-new-privileges:true'));
  assert.ok(backup.volumes.includes('backup-control:/run/isy-backup'));
  assert.deepEqual(backup.group_add, ['1001']);
  assert.equal(backup.ports, undefined);
  assert.equal(JSON.stringify(backup).includes('/var/run/docker.sock'), false);

  const initialize = compose.services['backup-control-init'];
  assert.equal(initialize.user, '0:0');
  assert.deepEqual(initialize.cap_drop, ['ALL']);
  assert.deepEqual(initialize.cap_add.sort(), ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
  assert.equal(initialize.read_only, true);
  assert.equal(initialize.restart, 'no');
  assert.deepEqual(Object.keys(compose.volumes).sort(), [
    'backup-cache',
    'backup-control',
    'backup-state',
    'installation-agent-state',
  ]);
});
