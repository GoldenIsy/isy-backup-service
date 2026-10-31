import fs from 'node:fs';
import path from 'node:path';
import { BackupError } from '../../domain/errors.js';
import { sha256 } from '../../domain/identity.js';
import type { CapturedSource, FilesystemSourceConfig } from '../../domain/types.js';
import { ensurePrivateDirectory, writeJsonAtomic } from '../../runtime/atomic.js';

interface InventoryEntry {
  path_sha256: string;
  content_sha256: string;
  bytes: number;
}

function safeRelative(relative: string): string {
  const normalized = path.normalize(relative);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new BackupError('SOURCE_PATH_ESCAPE', 4, 'filesystem entry escaped its configured root', 'capture');
  }
  return normalized;
}

function captureDirectory(root: string, destination: string): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = safeRelative(path.relative(root, absolute));
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new BackupError('SOURCE_SYMLINK_REJECTED', 4, 'filesystem source contains a symbolic link', 'capture');
      if (stat.isDirectory()) {
        ensurePrivateDirectory(path.join(destination, relative));
        walk(absolute);
      } else if (stat.isFile()) {
        const output = path.join(destination, relative);
        ensurePrivateDirectory(path.dirname(output));
        fs.copyFileSync(absolute, output, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(output, 0o600);
        const content = fs.readFileSync(output);
        entries.push({ path_sha256: sha256(relative), content_sha256: sha256(content), bytes: content.length });
      } else {
        throw new BackupError('SOURCE_TYPE_REJECTED', 4, 'filesystem source contains a non-file entry', 'capture');
      }
    }
  };
  walk(root);
  return entries;
}

export function captureFilesystem(source: FilesystemSourceConfig, sourceDirectory: string): CapturedSource {
  const root = path.resolve(source.root);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BackupError('SOURCE_INVALID', 4, `filesystem source ${source.id} is not a regular directory`, 'capture');
  const artifact = path.join(sourceDirectory, 'files');
  ensurePrivateDirectory(artifact);
  const inventory = captureDirectory(root, artifact);
  const inventoryFile = path.join(sourceDirectory, 'inventory.json');
  writeJsonAtomic(inventoryFile, { schema: 'isy.backup.filesystem-inventory/v1', entries: inventory });
  const serialized = JSON.stringify(inventory);
  return {
    id: source.id,
    type: source.type,
    required: source.required,
    result: 'PASS',
    artifact,
    sha256: sha256(serialized),
    bytes: inventory.reduce((total, item) => total + item.bytes, 0),
    entries: inventory.length
  };
}
