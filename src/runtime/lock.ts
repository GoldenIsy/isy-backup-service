import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BackupError } from '../domain/errors.js';
import { ensurePrivateDirectory } from './atomic.js';

const LEASE_REFRESH_MILLISECONDS = 30_000;
export const MUTATION_LOCK_STALE_MILLISECONDS = 24 * 60 * 60 * 1_000;

interface LockLease {
  schema: 'isy.backup.mutation-lock/v1';
  lease_id: string;
  operation_id: string;
  pid: number;
  created_at: string;
}

function parseLease(file: string): LockLease | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockLease>;
    return value.schema === 'isy.backup.mutation-lock/v1'
      && typeof value.lease_id === 'string'
      && typeof value.operation_id === 'string'
      && typeof value.pid === 'number'
      && typeof value.created_at === 'string'
      ? value as LockLease
      : null;
  } catch {
    return null;
  }
}

export function recoverStaleMutationLock(
  stateDirectory: string,
  now = new Date(),
  staleAfterMilliseconds = MUTATION_LOCK_STALE_MILLISECONDS
): boolean {
  const lock = path.join(stateDirectory, 'locks', 'mutation.lock');
  if (!fs.existsSync(lock)) return false;
  const stat = fs.statSync(lock);
  const age = now.getTime() - stat.mtimeMs;
  if (!Number.isFinite(age) || age < staleAfterMilliseconds) {
    throw new BackupError('LOCK_UNAVAILABLE', 8, 'a recent mutation lock is present; refusing unsafe automatic recovery', 'lock');
  }
  const quarantine = `${lock}.interrupted`;
  try { fs.unlinkSync(quarantine); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.renameSync(lock, quarantine);
  fs.unlinkSync(quarantine);
  return true;
}

export function acquireLock(stateDirectory: string, operationId = 'unspecified'): () => void {
  const directory = path.join(stateDirectory, 'locks');
  ensurePrivateDirectory(directory);
  const lock = path.join(directory, 'mutation.lock');
  const lease: LockLease = {
    schema: 'isy.backup.mutation-lock/v1',
    lease_id: crypto.randomUUID(),
    operation_id: operationId,
    pid: process.pid,
    created_at: new Date().toISOString()
  };
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(lease)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BackupError('LOCK_UNAVAILABLE', 8, 'another mutation operation is active', 'lock');
    throw error;
  }
  let ownershipLost = false;
  const refresh = setInterval(() => {
    try {
      if (parseLease(lock)?.lease_id !== lease.lease_id) {
        ownershipLost = true;
        clearInterval(refresh);
        return;
      }
      const current = new Date();
      fs.futimesSync(descriptor, current, current);
    } catch {
      ownershipLost = true;
      clearInterval(refresh);
    }
  }, LEASE_REFRESH_MILLISECONDS);
  refresh.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(refresh);
    const ownsLock = !ownershipLost && parseLease(lock)?.lease_id === lease.lease_id;
    fs.closeSync(descriptor);
    if (!ownsLock) throw new BackupError('LOCK_OWNERSHIP_LOST', 8, 'mutation lock ownership changed during the operation', 'lock');
    fs.unlinkSync(lock);
  };
}
