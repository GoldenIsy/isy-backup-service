import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });

test('receipt schema admits the bounded protocol and rejects unknown fields', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/receipt.schema.json', import.meta.url), 'utf8'));
  const validate = ajv.compile(schema);
  const receipt = {
    schema: 'isy.backup.receipt/v1',
    operation: 'backup',
    deployment: 'test',
    environment: 'test',
    backup_set_id: 'test-20261031T100000Z-01234567',
    result: 'PASS',
    started_at: '2026-10-31T10:00:00.000Z',
    completed_at: '2026-10-31T10:01:00.000Z',
    config_sha256: 'a'.repeat(64),
    image: { version: '0.1.0', source_revision: 'development', digest: null },
    sources: [],
    targets: [],
    findings: []
  };
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...receipt, secret: 'must-not-be-accepted' }), false);
  assert.match(JSON.stringify(validate.errors), /additionalProperties/u);
});

test('update event schema binds current and qualified immutable digests', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/update-event.schema.json', import.meta.url), 'utf8'));
  const validate = ajv.compile(schema);
  const event = {
    schema: 'isy.backup.update-event/v1',
    deployment: 'profilectric',
    environment: 'production',
    observed_at: '2026-10-31T10:00:00.000Z',
    current: { version: '0.1.0', digest: `sha256:${'a'.repeat(64)}` },
    qualified: { version: '0.2.0', digest: `sha256:${'b'.repeat(64)}` },
    result: 'UPDATE_AVAILABLE'
  };
  assert.equal(validate(event), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...event, current: { ...event.current, digest: 'main' } }), false);
});
