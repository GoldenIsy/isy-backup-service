import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory } from './atomic.js';

export function appendJournal(stateDirectory: string, operationId: string, state: string, at = new Date()): void {
  const directory = path.join(stateDirectory, 'journal');
  ensurePrivateDirectory(directory);
  const file = path.join(directory, `${operationId}.jsonl`);
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ state, at: at.toISOString() })}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
