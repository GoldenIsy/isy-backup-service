import fs from 'node:fs';
import path from 'node:path';
import { BackupError } from '../domain/errors.js';
import { ensurePrivateDirectory } from './atomic.js';

export function acquireLock(stateDirectory: string): () => void {
  const directory = path.join(stateDirectory, 'locks');
  ensurePrivateDirectory(directory);
  const lock = path.join(directory, 'mutation.lock');
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BackupError('LOCK_UNAVAILABLE', 8, 'another mutation operation is active', 'lock');
    throw error;
  }
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  };
}
