import fs from 'node:fs';
import path from 'node:path';
import { readSecret } from '../../config/load.js';
import { BackupError } from '../../domain/errors.js';
import { sha256 } from '../../domain/identity.js';
import type { CapturedSource, S3SourceConfig, ToolConfig } from '../../domain/types.js';
import { ensurePrivateDirectory, writeJsonAtomic } from '../../runtime/atomic.js';
import { runCommand } from '../../runtime/process.js';
import { createRedactor, credentialValuesFromText } from '../../security/redact.js';

interface InventoryEntry {
  path_sha256: string;
  content_sha256: string;
  bytes: number;
}

function inventory(root: string): InventoryEntry[] {
  const result: InventoryEntry[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new BackupError('SOURCE_SYMLINK_REJECTED', 4, 'object capture contains a symbolic link', 'capture');
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        const content = fs.readFileSync(absolute);
        result.push({ path_sha256: sha256(relative), content_sha256: sha256(content), bytes: content.length });
        fs.chmodSync(absolute, 0o600);
      } else throw new BackupError('SOURCE_TYPE_REJECTED', 4, 'object capture contains a non-file entry', 'capture');
    }
  };
  walk(root);
  return result;
}

export async function captureS3(source: S3SourceConfig, sourceDirectory: string, tools: ToolConfig = {}): Promise<CapturedSource> {
  const artifact = path.join(sourceDirectory, 'objects');
  ensurePrivateDirectory(artifact);
  const redactor = createRedactor(credentialValuesFromText(readSecret(source.config_file)));
  const binary = tools.rclone ?? 'rclone';
  const copied = await runCommand(binary, ['copy', source.remote, artifact, '--config', source.config_file, '--metadata', '--checksum'], {
    timeoutMs: 60 * 60_000,
    redact: redactor
  });
  if (copied.exitCode !== 0) throw new BackupError('S3_CAPTURE_FAILED', 4, `object capture failed: ${copied.stderr || 'rclone exited unsuccessfully'}`, 'capture');
  const checked = await runCommand(binary, ['check', source.remote, artifact, '--config', source.config_file, '--one-way', '--download'], {
    timeoutMs: 60 * 60_000,
    redact: redactor
  });
  if (checked.exitCode !== 0) throw new BackupError('S3_CAPTURE_INVALID', 4, `object capture verification failed: ${checked.stderr || 'rclone check failed'}`, 'capture');
  const entries = inventory(artifact);
  const serialized = JSON.stringify(entries);
  writeJsonAtomic(path.join(sourceDirectory, 'inventory.json'), { schema: 'isy.backup.object-inventory/v1', entries });
  return {
    id: source.id,
    type: source.type,
    required: source.required,
    result: 'PASS',
    artifact,
    sha256: sha256(serialized),
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries: entries.length
  };
}
