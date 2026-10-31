import fs from 'node:fs';
import path from 'node:path';
import { restoreSnapshot } from '../adapters/targets/restic.js';
import type { BackupConfig, TargetConfig } from '../domain/types.js';
import { BackupError } from '../domain/errors.js';

function overlaps(first: string, second: string): boolean {
  const a = path.resolve(first);
  const b = path.resolve(second);
  const relativeAB = path.relative(a, b);
  const relativeBA = path.relative(b, a);
  return relativeAB === '' || (!relativeAB.startsWith('..') && !path.isAbsolute(relativeAB)) || (!relativeBA.startsWith('..') && !path.isAbsolute(relativeBA));
}

export function validateRestoreOutput(config: BackupConfig, output: string): string {
  if (!path.isAbsolute(output)) throw new BackupError('RESTORE_TARGET_INVALID', 2, 'restore output must be absolute', 'restore');
  const resolved = path.resolve(output);
  const protectedPaths = [config.state_directory, config.staging_directory];
  for (const source of config.sources) if (source.type === 'filesystem') protectedPaths.push(source.root);
  for (const target of config.targets) if (target.type === 'filesystem') protectedPaths.push(target.repository);
  if (protectedPaths.some((protectedPath) => overlaps(protectedPath, resolved))) {
    throw new BackupError('RESTORE_TARGET_COLLISION', 6, 'restore output overlaps a protected source, state, staging, or repository path', 'restore');
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) {
    throw new BackupError('RESTORE_TARGET_NOT_EMPTY', 6, 'restore output must be absent or empty', 'restore');
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

export async function runRestore(config: BackupConfig, target: TargetConfig, snapshotId: string, output: string): Promise<void> {
  if (!/^[a-f0-9]{8,64}$/u.test(snapshotId)) throw new BackupError('RESTORE_SNAPSHOT_INVALID', 2, 'an immutable snapshot identity is required', 'restore');
  const destination = validateRestoreOutput(config, output);
  await restoreSnapshot(target, config.tools ?? {}, snapshotId, destination);
}
