/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  mutate: [
    'src/domain/results.ts',
    'src/evidence/store.ts',
    'src/runtime/lock.ts',
    'src/operations/restore.ts',
    'src/security/redact.ts'
  ],
  testRunner: 'tap',
  tap: {
    testFiles: [
      'tests/unit/**/*.test.mjs',
      'tests/integration/**/*.test.mjs'
    ]
  },
  buildCommand: 'npm run build',
  checkers: ['typescript'],
  coverageAnalysis: 'perTest',
  concurrency: 2,
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json'
  },
  thresholds: {
    high: 80,
    low: 65,
    break: 60
  },
  timeoutMS: 15_000,
  cleanTempDir: true
};

export default config;
