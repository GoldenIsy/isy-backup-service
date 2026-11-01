import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { startControlServer } from '../../dist/control/server.js';
import { ControlCommandService } from '../../dist/control/commands.js';
import { EvidenceStore, buildObservation } from '../../dist/evidence/store.js';
import { fixture } from '../helpers/fixture.mjs';

const image = { version: '0.2.0', source_revision: 'development', digest: null };

function request(socketPath, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const requestValue = http.request({
      socketPath,
      path: requestPath,
      method: options.method ?? 'GET',
      headers: options.headers ?? {}
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    requestValue.on('error', reject);
    if (options.body) requestValue.write(options.body);
    requestValue.end();
  });
}

function prepare(value) {
  const store = new EvidenceStore(value.state);
  const runtime = store.runtimeIdentity();
  store.publishObservation(buildObservation({
    installationId: '11111111-1111-4111-8111-111111111111',
    deployment: 'dev-isydocs', environment: 'development', runtimeInstanceId: runtime.runtime_instance_id,
    sequence: store.nextObservationSequence(), observedAt: new Date('2026-11-01T03:00:00.000Z'),
    configSha256: 'a'.repeat(64), image, serviceState: 'READY', schedulerResponsive: true,
    currentOperationId: null, nextBackupAt: null, status: {},
    capabilities: ['backup.observation.v1', 'backup.history.v1'],
    update: { state: 'UNKNOWN', available_version: null, available_digest: null }
  }));
  store.recordBackup({
    schema: 'isy.backup.receipt/v1', operation: 'backup', deployment: 'dev-isydocs', environment: 'development',
    backup_set_id: 'backup-001', result: 'PASS', started_at: '2026-11-01T02:59:00.000Z',
    completed_at: '2026-11-01T03:00:00.000Z', config_sha256: 'a'.repeat(64), image,
    sources: [{ id: 'files', type: 'filesystem', required: true, result: 'PASS', artifact: '/private/file', sha256: 'b'.repeat(64), bytes: 1, entries: 1 }],
    targets: [{ id: 'primary', type: 'filesystem', required: true, result: 'PASS', snapshot_id: '0123456789abcdef', verification: 'RESTIC_CHECK' }],
    findings: []
  }, 'schedule');
  return store;
}

function options(value, store) {
  return {
    socketPath: path.join(value.root, 'control.sock'),
    ownerUid: process.getuid(), groupGid: process.getgid(), mode: '0660',
    maximumReceiptPageSize: 25, maximumConnections: 4, evidenceStore: store
  };
}

function createStaleSocket(socketPath) {
  const script = `const net=require('node:net');const server=net.createServer();server.listen(${JSON.stringify(socketPath)},()=>process.exit(0));`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
}

test('read-only control socket serves bounded observations and denies every other route or method', async () => {
  const value = fixture();
  let server;
  try {
    const store = prepare(value);
    server = await startControlServer(options(value, store));
    const current = await request(server.socketPath, '/v1/observations/current');
    assert.equal(current.status, 200);
    assert.equal(current.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(current.body).schema, 'isy.backup.observation/v1');
    assert.deepEqual(JSON.parse((await request(server.socketPath, '/v1/status')).body), JSON.parse(current.body));

    assert.equal((await request(server.socketPath, '/v1/receipts?limit=1')).status, 200);
    const operation = await request(server.socketPath, '/v1/operations/backup-001');
    assert.equal(operation.status, 200);
    assert.equal(JSON.parse(operation.body).schema, 'isy.backup.receipt-summary/v1');
    assert.equal((await request(server.socketPath, '/v1/operations/missing')).status, 404);
    assert.equal((await request(server.socketPath, '/v1/commands/backup', { method: 'POST' })).status, 404);
    assert.equal((await request(server.socketPath, '/v1/status', { method: 'POST' })).status, 405);
    assert.equal((await request(server.socketPath, '/v1/status', { headers: { 'content-length': '1' }, body: 'x' })).status, 400);
    assert.equal((await request(server.socketPath, '/v1/receipts?limit=26')).status, 400);
    assert.equal((await request(server.socketPath, '/v1/receipts?limit=1&limit=2')).status, 400);
    assert.equal((await request(server.socketPath, '/v1/receipts?extra=1')).status, 400);
    assert.equal((await request(server.socketPath, `/v1/receipts?after=${'a'.repeat(257)}`)).status, 400);
  } finally {
    if (server) await server.close();
    value.cleanup();
  }
});

test('control socket has exact ownership and mode and disappears on orderly shutdown', async () => {
  const value = fixture();
  try {
    const server = await startControlServer(options(value, prepare(value)));
    const stat = fs.lstatSync(server.socketPath);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.gid, process.getgid());
    assert.equal(stat.mode & 0o777, 0o660);
    await server.close();
    assert.equal(fs.existsSync(server.socketPath), false);
  } finally { value.cleanup(); }
});

test('control socket refuses symlinks, regular files, and permissive stale sockets without removing them', async () => {
  for (const collision of ['symlink', 'file', 'permissive-socket']) {
    const value = fixture();
    const socketPath = path.join(value.root, 'control.sock');
    try {
      if (collision === 'symlink') fs.symlinkSync(path.join(value.root, 'elsewhere'), socketPath);
      if (collision === 'file') fs.writeFileSync(socketPath, 'do not replace');
      if (collision === 'permissive-socket') {
        createStaleSocket(socketPath);
        fs.chmodSync(socketPath, 0o666);
      }
      await assert.rejects(
        startControlServer(options(value, prepare(value))),
        /refuses|permission|collision/u,
        collision
      );
      assert.doesNotThrow(() => fs.lstatSync(socketPath));
      assert.equal(new EvidenceStore(value.state).listReceipts(null, 10).receipts.length, 1);
    } finally {
      value.cleanup();
    }
  }
});

test('an acceptable stale socket is replaced and restart preserves evidence cursors', async () => {
  const value = fixture();
  const socketPath = path.join(value.root, 'control.sock');
  try {
    createStaleSocket(socketPath);
    fs.chmodSync(socketPath, 0o660);

    const store = prepare(value);
    const first = await startControlServer(options(value, store));
    assert.equal(JSON.parse((await request(socketPath, '/v1/receipts')).body).receipts.length, 1);
    await first.close();
    const second = await startControlServer(options(value, new EvidenceStore(value.state)));
    assert.equal(JSON.parse((await request(socketPath, '/v1/observations/current')).body).sequence, 1);
    await second.close();
  } finally { value.cleanup(); }
});

test('control socket refuses a stale socket with unexpected group and a symlinked parent', async () => {
  const wrongGroup = fixture();
  try {
    const socketPath = path.join(wrongGroup.root, 'control.sock');
    createStaleSocket(socketPath);
    fs.chmodSync(socketPath, 0o660);
    const configured = options(wrongGroup, prepare(wrongGroup));
    configured.groupGid = process.getgid() + 1;
    await assert.rejects(startControlServer(configured), /ownership|permission|collision/u);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally { wrongGroup.cleanup(); }

  const linkedParent = fixture();
  try {
    const real = path.join(linkedParent.root, 'real-runtime');
    const linked = path.join(linkedParent.root, 'linked-runtime');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, linked);
    const configured = options(linkedParent, prepare(linkedParent));
    configured.socketPath = path.join(linked, 'control.sock');
    await assert.rejects(startControlServer(configured), /unsafe ownership or permissions/u);
    assert.equal(fs.existsSync(path.join(real, 'control.sock')), false);
  } finally { linkedParent.cleanup(); }
});

test('control socket serves concurrent readers within its explicit connection bound', async () => {
  const value = fixture();
  let server;
  try {
    server = await startControlServer(options(value, prepare(value)));
    const responses = await Promise.all(Array.from({ length: 4 }, () => request(server.socketPath, '/v1/status')));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200]);
  } finally {
    if (server) await server.close();
    value.cleanup();
  }
});

test('control socket durably executes one allowlisted command and reuses its final result', async () => {
  const value = fixture(); let server; let executions = 0;
  try {
    const commandService = new ControlCommandService({
      stateDirectory: value.state,
      installationId: '11111111-1111-4111-8111-111111111111',
      configSha256: 'a'.repeat(64), allowedCommands: ['repository-check'],
      capabilities: ['backup.repository-check.v1'],
      execute: async (command) => {
        executions += 1;
        return { schema: 'isy.backup.command-result/v1', command_id: command.command_id,
          idempotency_key: command.idempotency_key, command_digest: command.command_digest,
          state: 'SUCCEEDED', code: 'REPOSITORY_CHECK_PASS', operation_id: command.command_id,
          receipt_cursor: 'r0000000000001', started_at: command.issued_at, completed_at: command.issued_at };
      },
      now: () => Date.parse('2026-11-01T03:00:00.000Z')
    });
    const configured = options(value, prepare(value)); configured.commandService = commandService;
    server = await startControlServer(configured);
    const command = {
      schema: 'isy.backup.command/v1', command_id: '88888888-8888-4888-8888-888888888888',
      idempotency_key: '99999999-9999-4999-8999-999999999999',
      installation_id: '11111111-1111-4111-8111-111111111111',
      command_digest: `sha256:${'b'.repeat(64)}`, action: 'repository-check', payload: { target_id: null },
      expected_config_sha256: 'a'.repeat(64), required_capability: 'backup.repository-check.v1',
      issued_at: '2026-11-01T02:59:00.000Z', expires_at: '2026-11-01T03:05:00.000Z'
    };
    const submit = () => request(server.socketPath, '/v1/commands/repository-check', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command)
    });
    assert.equal((await submit()).status, 200);
    assert.equal((await submit()).status, 200);
    assert.equal(executions, 1);
    assert.equal(fs.existsSync(path.join(value.state, 'control-commands', `${command.command_id}.json`)), true);
  } finally { if (server) await server.close(); value.cleanup(); }
});

test('control socket cancels only the named running operation', async () => {
  const value = fixture(); let server; let started;
  const running = new Promise((resolve) => { started = resolve; });
  try {
    const commandService = new ControlCommandService({
      stateDirectory: value.state,
      installationId: '11111111-1111-4111-8111-111111111111',
      configSha256: 'a'.repeat(64), allowedCommands: ['backup', 'cancel'],
      capabilities: ['backup.run.v1', 'backup.cancel.v1'],
      execute: async (command, signal) => {
        started();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { schema: 'isy.backup.command-result/v1', command_id: command.command_id,
          idempotency_key: command.idempotency_key, command_digest: command.command_digest,
          state: 'CANCELLED', code: 'COMMAND_CANCELLED', operation_id: command.command_id,
          receipt_cursor: null, started_at: command.issued_at, completed_at: command.issued_at };
      },
      now: () => Date.parse('2026-11-01T03:00:00.000Z')
    });
    const configured = options(value, prepare(value)); configured.commandService = commandService;
    server = await startControlServer(configured);
    const backup = {
      schema: 'isy.backup.command/v1', command_id: '77777777-7777-4777-8777-777777777777',
      idempotency_key: '66666666-6666-4666-8666-666666666666',
      installation_id: '11111111-1111-4111-8111-111111111111',
      command_digest: `sha256:${'c'.repeat(64)}`, action: 'backup', payload: {},
      expected_config_sha256: 'a'.repeat(64), required_capability: 'backup.run.v1',
      issued_at: '2026-11-01T02:59:00.000Z', expires_at: '2026-11-01T03:05:00.000Z'
    };
    const backupResponse = request(server.socketPath, '/v1/commands/backup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup)
    });
    await running;
    const cancel = {
      schema: 'isy.backup.command/v1', command_id: '55555555-5555-4555-8555-555555555555',
      idempotency_key: '44444444-4444-4444-8444-444444444444',
      installation_id: backup.installation_id, command_digest: `sha256:${'d'.repeat(64)}`,
      action: 'cancel', payload: { operation_id: backup.command_id },
      expected_config_sha256: backup.expected_config_sha256, required_capability: 'backup.cancel.v1',
      issued_at: backup.issued_at, expires_at: backup.expires_at
    };
    const cancelled = await request(server.socketPath, '/v1/commands/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cancel)
    });
    assert.equal(cancelled.status, 200);
    assert.equal(JSON.parse(cancelled.body).code, 'CANCELLATION_REQUESTED');
    const final = await backupResponse;
    assert.equal(final.status, 200);
    assert.equal(JSON.parse(final.body).state, 'CANCELLED');
  } finally { if (server) await server.close(); value.cleanup(); }
});
