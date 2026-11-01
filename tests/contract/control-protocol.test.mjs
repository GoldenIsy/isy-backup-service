import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

const schema = JSON.parse(fs.readFileSync(
  new URL('../../schemas/control/v1/protocol.schema.json', import.meta.url),
  'utf8'
));
const fixtures = JSON.parse(fs.readFileSync(
  new URL('../../schemas/control/v1/payload-fixtures.json', import.meta.url),
  'utf8'
));
const manifest = JSON.parse(fs.readFileSync(
  new URL('../../schemas/control/v1/upstream-manifest.json', import.meta.url),
  'utf8'
));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value) => value.endsWith('Z') && Number.isFinite(Date.parse(value))
});
ajv.addSchema(schema);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutate(value, mutation) {
  const result = clone(value);
  let parent = result;
  for (const segment of mutation.path.slice(0, -1)) {
    parent = parent[Array.isArray(parent) ? Number(segment) : segment];
  }
  const leaf = mutation.path.at(-1);
  if (mutation.operation === 'remove') {
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
    else delete parent[leaf];
  } else if (Array.isArray(parent)) {
    parent[Number(leaf)] = clone(mutation.value);
  } else {
    parent[leaf] = clone(mutation.value);
  }
  return result;
}

function validator(definition) {
  const result = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  assert.ok(result, `missing validator ${definition}`);
  return result;
}

test('local control protocol manifest pins every vendorable file', () => {
  assert.equal(manifest.schema, 'isy.backup.control-protocol-upstream-manifest/v1');
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'payload-fixtures.json',
    'protocol.schema.json'
  ]);
  for (const [filename, expected] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(new URL(`../../schemas/control/v1/${filename}`, import.meta.url));
    assert.equal(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, expected, filename);
  }
});

test('local control fixtures cover every public definition in schema order', () => {
  assert.equal(fixtures.schema, 'isy.backup.control-payload-fixtures/v1');
  const definitions = schema.oneOf.map(({ $ref }) => $ref.split('/').at(-1));
  assert.deepEqual(fixtures.payloads.map(({ definition }) => definition), definitions);
  for (const entry of fixtures.payloads) {
    assert.equal(schema.$defs[entry.definition].properties.schema.const, entry.wire_schema);
    assert.equal(entry.valid.schema, entry.wire_schema);
  }
});

for (const entry of fixtures.payloads) {
  test(`local control ${entry.definition} accepts its valid fixture`, () => {
    const validate = validator(entry.definition);
    assert.equal(validate(clone(entry.valid)), true, JSON.stringify(validate.errors));
  });

  test(`local control ${entry.definition} rejects every invalid mutation`, () => {
    const validate = validator(entry.definition);
    for (const mutation of entry.invalid) {
      assert.equal(validate(mutate(entry.valid, mutation)), false, JSON.stringify(mutation));
    }
  });
}

test('local control boundary vectors are enforced', () => {
  const byDefinition = new Map(fixtures.payloads.map((entry) => [entry.definition, entry.valid]));
  for (const vector of fixtures.boundary_vectors) {
    const validate = validator(vector.definition);
    let value = clone(byDefinition.get(vector.definition));
    if (vector.repeat_valid_receipt) {
      const receipt = clone(byDefinition.get('receiptSummary'));
      value.receipts = Array.from({ length: vector.repeat_valid_receipt }, () => clone(receipt));
    } else {
      value = mutate(value, { operation: 'replace', path: vector.path, value: vector.value });
    }
    assert.equal(validate(value), vector.accepted, JSON.stringify(validate.errors));
  }
});

test('valid local payloads contain no secret, path, URL, raw output, or customer-content fields', () => {
  const validText = JSON.stringify(fixtures.payloads.map(({ valid }) => valid));
  for (const forbidden of [
    'access_token', 'credential', 'customer_data', 'environment_variable', 'filename',
    'object_name', 'password', 'path', 'raw_output', 'repository_url', 'secret', 'url'
  ]) {
    assert.equal(validText.includes(`\"${forbidden}\"`), false, forbidden);
  }
});
