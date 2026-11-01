import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  EvidenceStore,
  buildBackupReceiptSummary,
  buildObservation,
  observationState,
  selectProtectedReceiptCursors
} from '../../dist/evidence/store.js';
import { fixture } from '../helpers/fixture.mjs';

const image = { version: '0.2.0', source_revision: 'development', digest: null };
const controlSchema = JSON.parse(fs.readFileSync(new URL('../../schemas/control/v1/protocol.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('date-time', { type: 'string', validate: (value) => value.endsWith('Z') && Number.isFinite(Date.parse(value)) });
ajv.addSchema(controlSchema);

function assertProtocol(definition, value) {
  const validate = ajv.getSchema(`${controlSchema.$id}#/$defs/${definition}`);
  assert.ok(validate, `validator ${definition}`);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function receipt(id, result = 'PASS', completedAt = '2026-11-01T01:00:00.000Z') {
  const targetResult = result === 'FAIL' ? 'FAIL' : 'PASS';
  return {
    schema: 'isy.backup.receipt/v1',
    operation: 'backup',
    deployment: 'dev-isydocs',
    environment: 'development',
    backup_set_id: id,
    result,
    started_at: '2026-11-01T00:59:00.000Z',
    completed_at: completedAt,
    config_sha256: 'a'.repeat(64),
    image,
    sources: [{
      id: 'database', type: 'postgres', required: true, result: 'PASS',
      artifact: '/secret/customer/database.dump', sha256: 'b'.repeat(64), bytes: 42,
      entries: 1, finding: undefined
    }],
    targets: [{
      id: 'pcloud-eu', type: 'rclone', required: true, result: targetResult,
      snapshot_id: targetResult === 'PASS' ? '0123456789abcdef' : null,
      verification: targetResult === 'PASS' ? 'RESTIC_READ_DATA' : 'NONE',
      finding: targetResult === 'FAIL' ? {
        code: 'TARGET_SNAPSHOT_FAILED', phase: 'target', owner: 'isy-backup-agent',
        detail: 'token=provider-secret https://user:password@example.invalid/private/file',
        next_action: 'inspect /private/file'
      } : undefined
    }],
    findings: targetResult === 'FAIL' ? [{
      code: 'TARGET_SNAPSHOT_FAILED', phase: 'target', owner: 'isy-backup-agent',
      detail: 'token=provider-secret https://user:password@example.invalid/private/file',
      next_action: 'inspect /private/file'
    }] : []
  };
}

test('receipt projection is allowlisted, bounded, and omits hostile local details', () => {
  const summary = buildBackupReceiptSummary(receipt('backup-001', 'FAIL'), 'schedule', 'cursor-1');
  assert.equal(summary.operation.trigger, 'schedule');
  assert.equal(summary.sources[0].type, 'postgresql');
  assert.equal(summary.targets[0].verification, 'NONE');
  assert.deepEqual(summary.finding_codes, ['TARGET_SNAPSHOT_FAILED']);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /provider-secret|password@example|private\/file|"artifact"|"sha256"/u);
  assert.deepEqual(Object.keys(summary).sort(), [
    'backup_set_id', 'cursor', 'finding_codes', 'image', 'operation', 'result', 'schema', 'sources', 'targets'
  ]);
  assertProtocol('receiptSummary', summary);
});

test('receipt projection maps every source, provider, verification, fallback, and bound explicitly', () => {
  const value = receipt('backup-mapping');
  value.sources = [
    { ...value.sources[0], id: 'pg', type: 'postgres', bytes: 0, entries: 0 },
    { ...value.sources[0], id: 'objects', type: 's3', bytes: -1, entries: undefined, finding: { code: 'invalid-code' } },
    { ...value.sources[0], id: 'files', type: 'filesystem', bytes: Number.MAX_SAFE_INTEGER + 1, entries: -1 }
  ];
  value.targets = [
    { ...value.targets[0], id: 'local', type: 'filesystem', verification: 'RESTIC_CHECK' },
    { ...value.targets[0], id: 'object', type: 's3', verification: 'RESTIC_READ_DATA' },
    { ...value.targets[0], id: 'cloud', type: 'rclone', verification: 'NONE', result: 'FAIL', snapshot_id: null }
  ];
  value.findings = Array.from({ length: 70 }, (_, index) => ({ code: `CODE_${index}` }));
  const summary = buildBackupReceiptSummary(value, 'recovery', 'cursor-map');
  assert.deepEqual(summary.sources.map((item) => item.type), ['postgresql', 's3', 'filesystem']);
  assert.deepEqual(summary.sources.map((item) => [item.bytes, item.entries, item.code]), [
    [0, 0, 'SOURCE_PASS'], [null, null, 'SOURCE_PASS'], [null, null, 'SOURCE_PASS']
  ]);
  assert.deepEqual(summary.targets.map((item) => item.provider_class), ['filesystem', 's3', 'rclone']);
  assert.deepEqual(summary.targets.map((item) => item.verification), ['METADATA', 'READ_DATA', 'NONE']);
  assert.deepEqual(summary.targets.map((item) => item.verified_at), [value.completed_at, value.completed_at, null]);
  assert.equal(summary.finding_codes.length, 64);
  assert.deepEqual(summary.finding_codes, [...summary.finding_codes].sort());

  value.sources = Array.from({ length: 40 }, (_, index) => ({ ...value.sources[0], id: `source-${index}` }));
  value.targets = Array.from({ length: 20 }, (_, index) => ({ ...value.targets[0], id: `target-${index}` }));
  const bounded = buildBackupReceiptSummary(value, 'local-manual', 'cursor-bounded');
  assert.equal(bounded.sources.length, 32);
  assert.equal(bounded.targets.length, 16);
});

test('evidence store preserves immutable summaries and ordered bounded cursors across restart', () => {
  const value = fixture();
  try {
    const first = new EvidenceStore(value.state);
    const runtime = first.runtimeIdentity();
    assert.match(runtime.runtime_instance_id, /^[0-9a-f-]{36}$/u);
    assert.equal(first.nextObservationSequence(), 1);
    const one = first.recordBackup(receipt('backup-001'), 'schedule');
    const two = first.recordBackup(receipt('backup-002', 'FAIL', '2026-11-01T02:00:00.000Z'), 'schedule');
    assert.notEqual(one.cursor, two.cursor);
    assert.throws(() => first.recordBackup(receipt('backup-001'), 'schedule'), /already exists/u);

    const restarted = new EvidenceStore(value.state);
    assert.equal(restarted.runtimeIdentity().runtime_instance_id, runtime.runtime_instance_id);
    assert.equal(restarted.nextObservationSequence(), 2);
    assert.deepEqual(restarted.listReceipts(null, 1).receipts.map((item) => item.backup_set_id), ['backup-001']);
    assert.deepEqual(restarted.listReceipts(one.cursor, 10).receipts.map((item) => item.backup_set_id), ['backup-002']);
    assertProtocol('receiptPage', restarted.listReceipts(null, 10));
    assert.throws(() => restarted.listReceipts('unknown-cursor', 10), /unknown receipt cursor/u);
    assert.throws(() => restarted.listReceipts(null, 101), /between 1 and 100/u);
    assert.throws(() => restarted.listReceipts(null, 0), /between 1 and 100/u);
    assert.throws(() => restarted.listReceipts(null, 1.5), /between 1 and 100/u);
  } finally { value.cleanup(); }
});

test('corrupt or exhausted persisted observation sequence fails closed', () => {
  for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const value = fixture();
    try {
      const store = new EvidenceStore(value.state);
      fs.writeFileSync(path.join(value.state, 'evidence', 'observation-sequence.json'), JSON.stringify({ sequence }));
      assert.throws(() => store.nextObservationSequence(), /invalid persisted observation sequence/u);
    } finally { value.cleanup(); }
  }
});

test('current observation separates scheduler, service, freshness, verification, and update evidence', () => {
  const value = fixture();
  try {
    const store = new EvidenceStore(value.state);
    const observation = buildObservation({
      installationId: '11111111-1111-4111-8111-111111111111',
      deployment: 'dev-isydocs', environment: 'development',
      runtimeInstanceId: store.runtimeIdentity().runtime_instance_id,
      sequence: store.nextObservationSequence(), observedAt: new Date('2026-11-01T03:00:00.000Z'),
      configSha256: 'a'.repeat(64), image, serviceState: 'DEGRADED', schedulerResponsive: true,
      currentOperationId: null, nextBackupAt: null,
      status: {
        last_attempt_at: '2026-11-01T02:00:00.000Z',
        last_required_success_at: '2026-11-01T01:00:00.000Z',
        target_freshness: { 'pcloud-eu': '2026-11-01T01:00:00.000Z' },
        finding_codes: ['TARGET_SNAPSHOT_FAILED']
      },
      capabilities: ['backup.observation.v1', 'backup.history.v1'],
      update: { state: 'AVAILABLE', available_version: '0.3.0', available_digest: `sha256:${'c'.repeat(64)}` }
    });
    store.publishObservation(observation);
    assert.deepEqual(store.currentObservation(), observation);
    assert.equal(observation.scheduler_responsive, true);
    assert.equal(observation.state, 'DEGRADED');
    assert.equal(observation.update.state, 'AVAILABLE');
    assertProtocol('observation', observation);
    assert.deepEqual(observation.finding_codes, ['TARGET_SNAPSHOT_FAILED']);
    assert.deepEqual(observation.capabilities, ['backup.history.v1', 'backup.observation.v1']);
    assert.deepEqual(observation.target_freshness, { 'pcloud-eu': '2026-11-01T01:00:00.000Z' });
    assert.equal(observationState('DEGRADED'), 'DEGRADED');
    assert.equal(observationState('STARTING'), 'DEGRADED');
    assert.equal(observationState('STOPPING'), 'FAILED');
    assert.equal(observationState('RUNNING'), 'READY');
  } finally { value.cleanup(); }
});

test('observation applies empty defaults, uniqueness, stable ordering, and protocol bounds', () => {
  const observation = buildObservation({
    installationId: '11111111-1111-4111-8111-111111111111', deployment: 'dev', environment: 'test',
    runtimeInstanceId: '22222222-2222-4222-8222-222222222222', sequence: 1,
    observedAt: new Date('2026-11-01T03:00:00.000Z'), configSha256: 'a'.repeat(64), image,
    serviceState: 'READY', schedulerResponsive: true, currentOperationId: null, nextBackupAt: null,
    status: {},
    capabilities: [...Array.from({ length: 40 }, (_, index) => `backup.capability-${index}.v1`), 'backup.capability-0.v1'],
    update: { state: 'UNKNOWN', available_version: null, available_digest: null }
  });
  assert.deepEqual(observation.target_freshness, {});
  assert.deepEqual(observation.finding_codes, []);
  assert.equal(observation.capabilities.length, 32);
  assert.equal(new Set(observation.capabilities).size, 32);
  assert.deepEqual(observation.capabilities, [...observation.capabilities].sort());
  assertProtocol('observation', observation);
});

test('retention protects latest required success and only unresolved latest failure', () => {
  const summaries = [
    buildBackupReceiptSummary(receipt('pass-old'), 'schedule', 'cursor-1'),
    buildBackupReceiptSummary(receipt('fail-unresolved', 'FAIL', '2026-11-01T02:00:00.000Z'), 'schedule', 'cursor-2'),
    buildBackupReceiptSummary(receipt('pass-latest', 'PASS', '2026-11-01T03:00:00.000Z'), 'schedule', 'cursor-3')
  ];
  assert.deepEqual([...selectProtectedReceiptCursors(summaries)].sort(), ['cursor-3']);

  const unresolved = summaries.slice(0, 2);
  assert.deepEqual([...selectProtectedReceiptCursors(unresolved)].sort(), ['cursor-1', 'cursor-2']);

  const requiredSourceFailure = buildBackupReceiptSummary(receipt('required-source-fail'), 'schedule', 'cursor-4');
  requiredSourceFailure.sources[0].result = 'FAIL';
  requiredSourceFailure.result = 'WARN';
  const optionalTargetFailure = buildBackupReceiptSummary(receipt('optional-target-fail'), 'schedule', 'cursor-5');
  optionalTargetFailure.targets[0].required = false;
  optionalTargetFailure.targets[0].result = 'FAIL';
  optionalTargetFailure.operation.completed_at = '2026-11-01T04:00:00.000Z';
  assert.deepEqual(
    [...selectProtectedReceiptCursors([requiredSourceFailure, optionalTargetFailure])],
    ['cursor-5']
  );

  const restoreTest = buildBackupReceiptSummary(receipt('restore-proof'), 'schedule', 'cursor-6');
  restoreTest.operation.kind = 'restore-test';
  const unknown = buildBackupReceiptSummary(receipt('unknown-proof'), 'schedule', 'cursor-7');
  unknown.result = 'UNKNOWN';
  unknown.operation.completed_at = '2026-11-01T05:00:00.000Z';
  assert.deepEqual(
    [...selectProtectedReceiptCursors([summaries[2], restoreTest, unknown])].sort(),
    ['cursor-6', 'cursor-7']
  );
});

test('retention removes only oldest unprotected evidence and never below protected count', () => {
  const value = fixture();
  try {
    const store = new EvidenceStore(value.state);
    store.recordBackup(receipt('pass-old', 'PASS', '2026-11-01T01:00:00.000Z'), 'schedule');
    store.recordBackup(receipt('fail-resolved', 'FAIL', '2026-11-01T02:00:00.000Z'), 'schedule');
    const latest = store.recordBackup(receipt('pass-latest', 'PASS', '2026-11-01T03:00:00.000Z'), 'schedule');
    assert.deepEqual(store.pruneReceipts(1), { removed: 2, retained: 1, protected: 1 });
    assert.deepEqual(store.listReceipts(null, 100).receipts.map((item) => item.cursor), [latest.cursor]);
    assert.equal(fs.readdirSync(path.join(value.state, 'evidence', 'receipts')).length, 1);
  } finally { value.cleanup(); }
});
