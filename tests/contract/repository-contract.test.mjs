import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const authorityFiles = [
  'README.md',
  'BACKUP_SERVICE_CONTRACT.md',
  'IMPLEMENTATION_CONTRACT.md',
  'TESTING_CONTRACT.md',
  'docs/ON_PREMISE_DEPLOYMENT.md',
  'docs/SAAS_CONTROL_PLANE_INTEGRATION.md'
];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function repositoryFiles(directory = root) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (['.git', 'node_modules', 'coverage', 'tmp'].includes(entry.name)) return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? repositoryFiles(absolute) : [absolute];
  });
}

test('documentation authorities are well formed', () => {
  for (const relative of authorityFiles) {
    const value = read(relative);
    assert.ok(value.startsWith('# '), `${relative} must start with one H1`);
    assert.ok(value.endsWith('\n'), `${relative} must end with a newline`);
    assert.doesNotMatch(value, /[ \t]+$/mu, `${relative} has trailing whitespace`);
    const fences = value.match(/^```/gmu) ?? [];
    assert.equal(fences.length % 2, 0, `${relative} has unbalanced code fences`);
  }
});

test('relative Markdown links resolve to repository files', () => {
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/gu;
  for (const relative of authorityFiles) {
    const value = read(relative);
    for (const match of value.matchAll(markdownLink)) {
      const target = match[1].split('#', 1)[0];
      if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
      const resolved = path.resolve(path.dirname(path.join(root, relative)), decodeURI(target));
      assert.ok(resolved.startsWith(`${root}${path.sep}`), `${relative} link escapes repository: ${target}`);
      assert.ok(fs.existsSync(resolved), `${relative} link is missing: ${target}`);
    }
  }
});

test('README routes readers to every contract authority', () => {
  const readme = read('README.md');
  for (const relative of authorityFiles.slice(1)) {
    assert.match(readme, new RegExp(`\\]\\(${relative.replaceAll('.', '\\.')}\\)`, 'u'));
  }
});

test('required risk scenarios remain unique and discoverable', () => {
  const testingContract = read('TESTING_CONTRACT.md');
  const required = [
    'CFG-001', 'SEC-001', 'SEC-002', 'BKP-001', 'CON-001', 'DST-001',
    'DST-002', 'INT-001', 'INT-002', 'RST-001', 'RST-002', 'OPS-001',
    'OPS-002', 'MON-001', 'MON-002', 'MON-003', 'RET-001', 'RET-002',
    'PCL-001', 'PCL-002', 'SUP-001'
  ];
  const headings = [...testingContract.matchAll(/^### ([A-Z]{3}-\d{3})\b/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, required);
  assert.equal(new Set(headings).size, headings.length, 'scenario IDs must be unique');
});

test('versioned repository text contains no obvious live credential material', () => {
  const textFiles = repositoryFiles().filter((file) => /\.(?:md|json|ya?ml|mjs|ts|js|env)$/u.test(file));
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/u,
    /["']access_token["']\s*:\s*["'](?!<|replace|test|redacted)[A-Za-z0-9._-]{12,}["']/iu
  ];
  for (const file of textFiles) {
    const value = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(value, pattern, `${path.relative(root, file)} contains credential-like material`);
    }
  }
});
