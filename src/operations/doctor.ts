import fs from 'node:fs';
import type { BackupConfig } from '../domain/types.js';
import { runCommand } from '../runtime/process.js';

export interface DoctorResult {
  result: 'PASS' | 'FAIL';
  checks: Array<{ name: string; result: 'PASS' | 'FAIL'; detail: string }>;
}

export async function doctor(config: BackupConfig): Promise<DoctorResult> {
  const checks: DoctorResult['checks'] = [];
  for (const [name, directory] of [['state_directory', config.state_directory], ['staging_directory', config.staging_directory]] as const) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      checks.push({ name, result: 'PASS', detail: 'readable and writable' });
    } catch {
      checks.push({ name, result: 'FAIL', detail: 'not readable and writable' });
    }
  }
  const tools = new Map<string, string>();
  tools.set('restic', config.tools?.restic ?? 'restic');
  if (config.sources.some((source) => source.type === 'postgres')) {
    tools.set('pg_dump', config.tools?.pg_dump ?? 'pg_dump');
    tools.set('pg_restore', config.tools?.pg_restore ?? 'pg_restore');
  }
  if (config.sources.some((source) => source.type === 's3')) tools.set('rclone', config.tools?.rclone ?? 'rclone');
  for (const [name, binary] of tools) {
    try {
      const result = await runCommand(binary, ['--version'], { timeoutMs: 10_000 });
      checks.push({ name, result: result.exitCode === 0 ? 'PASS' : 'FAIL', detail: result.exitCode === 0 ? result.stdout.trim().slice(0, 200) : 'version command failed' });
    } catch {
      checks.push({ name, result: 'FAIL', detail: 'binary unavailable' });
    }
  }
  return { result: checks.every((check) => check.result === 'PASS') ? 'PASS' : 'FAIL', checks };
}
