import fs from 'node:fs';
import path from 'node:path';
import { BackupError } from '../../domain/errors.js';
import { sha256 } from '../../domain/identity.js';
import type { CapturedSource, PostgresSourceConfig, ToolConfig } from '../../domain/types.js';
import { runCommand } from '../../runtime/process.js';
import { createRedactor } from '../../security/redact.js';
import { readSecret } from '../../config/load.js';

export async function capturePostgres(source: PostgresSourceConfig, sourceDirectory: string, tools: ToolConfig = {}): Promise<CapturedSource> {
  const artifact = path.join(sourceDirectory, 'database.dump');
  const redactor = createRedactor([readSecret(source.password_file)]);
  const dump = await runCommand(tools.pg_dump ?? 'pg_dump', [
    '--host', source.host,
    '--port', String(source.port),
    '--username', source.username,
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file', artifact,
    source.database
  ], { env: { PGPASSFILE: source.password_file }, timeoutMs: 30 * 60_000, redact: redactor });
  if (dump.exitCode !== 0) throw new BackupError('POSTGRES_CAPTURE_FAILED', 4, `PostgreSQL capture failed: ${dump.stderr || 'pg_dump exited unsuccessfully'}`, 'capture');
  const stat = fs.statSync(artifact);
  if (!stat.isFile() || stat.size === 0) throw new BackupError('POSTGRES_CAPTURE_EMPTY', 4, 'PostgreSQL capture produced an empty artifact', 'capture');
  fs.chmodSync(artifact, 0o600);
  const validation = await runCommand(tools.pg_restore ?? 'pg_restore', ['--list', artifact], { timeoutMs: 5 * 60_000, redact: redactor });
  if (validation.exitCode !== 0 || validation.stdout.trim() === '') {
    throw new BackupError('POSTGRES_CAPTURE_INVALID', 4, `PostgreSQL capture validation failed: ${validation.stderr || 'empty catalog'}`, 'capture');
  }
  return {
    id: source.id,
    type: source.type,
    required: source.required,
    result: 'PASS',
    artifact,
    sha256: sha256(fs.readFileSync(artifact)),
    bytes: stat.size
  };
}
