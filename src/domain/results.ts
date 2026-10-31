import type { CapturedSource, Result, TargetResult } from './types.js';

export function aggregateResult(sources: CapturedSource[], targets: TargetResult[]): Result {
  const items = [...sources, ...targets];
  if (items.some((item) => item.required && item.result !== 'PASS')) return 'FAIL';
  if (items.some((item) => item.result !== 'PASS')) return 'WARN';
  return 'PASS';
}
