import { readSecret } from '../../config/load.js';
import { BackupError } from '../../domain/errors.js';
import type { TargetConfig, TargetResult, ToolConfig } from '../../domain/types.js';
import { runCommand, type CommandResult } from '../../runtime/process.js';
import { createRedactor, credentialValuesFromText } from '../../security/redact.js';
import { ensurePrivateDirectory } from '../../runtime/atomic.js';

interface ResticContext {
  binary: string;
  args: string[];
  env: Record<string, string>;
  redact: (value: string) => string;
}

function context(target: TargetConfig, tools: ToolConfig = {}): ResticContext {
  const secrets = credentialValuesFromText(readSecret(target.password_file));
  const resticCache = `${target.cache_directory}/restic`;
  const rcloneCache = `${target.cache_directory}/rclone`;
  const temporary = `${target.cache_directory}/tmp`;
  ensurePrivateDirectory(resticCache);
  ensurePrivateDirectory(rcloneCache);
  ensurePrivateDirectory(temporary);
  const env: Record<string, string> = {
    RESTIC_PASSWORD_FILE: target.password_file,
    RESTIC_CACHE_DIR: resticCache,
    RCLONE_CACHE_DIR: rcloneCache,
    TMPDIR: temporary
  };
  for (const [name, file] of Object.entries(target.environment_secret_files ?? {})) {
    const value = readSecret(file);
    secrets.push(...credentialValuesFromText(value));
    env[name] = value;
  }
  for (const [name, file] of Object.entries(target.environment_file_references ?? {})) {
    secrets.push(...credentialValuesFromText(readSecret(file)));
    env[name] = file;
  }
  return {
    binary: tools.restic ?? 'restic',
    args: ['--repo', target.repository],
    env,
    redact: createRedactor(secrets)
  };
}

async function execute(target: TargetConfig, tools: ToolConfig, args: string[], timeoutMs = 30 * 60_000): Promise<CommandResult> {
  const command = context(target, tools);
  return await runCommand(command.binary, [...command.args, ...args], { env: command.env, redact: command.redact, timeoutMs });
}

function assertPassed(result: CommandResult, code: string, exitCode: number, action: string): void {
  if (result.exitCode !== 0) throw new BackupError(code, exitCode, `${action} failed: ${result.stderr || 'dependency exited unsuccessfully'}`, 'target');
}

export async function initializeRepository(target: TargetConfig, tools: ToolConfig = {}): Promise<void> {
  const result = await execute(target, tools, ['init'], 5 * 60_000);
  assertPassed(result, 'REPOSITORY_INIT_FAILED', 5, `target ${target.id} initialization`);
}

export async function snapshot(target: TargetConfig, tools: ToolConfig, stagingDirectory: string, backupSetId: string): Promise<TargetResult> {
  const backup = await execute(target, tools, ['backup', stagingDirectory, '--json', '--tag', `isy-backup-set:${backupSetId}`]);
  assertPassed(backup, 'TARGET_SNAPSHOT_FAILED', 5, `target ${target.id} snapshot`);
  let snapshotId: string | null = null;
  for (const line of backup.stdout.split('\n')) {
    try {
      const message = JSON.parse(line) as { message_type?: string; snapshot_id?: string };
      if (message.message_type === 'summary' && typeof message.snapshot_id === 'string') snapshotId = message.snapshot_id;
    } catch {
      // Restic may emit non-JSON progress on some versions; the exit status remains authoritative.
    }
  }
  if (!snapshotId) throw new BackupError('TARGET_RECEIPT_INVALID', 5, `target ${target.id} did not report a snapshot identity`, 'target');
  const check = await execute(target, tools, ['check'], 60 * 60_000);
  assertPassed(check, 'TARGET_CHECK_FAILED', 6, `target ${target.id} check`);
  return { id: target.id, type: target.type, required: target.required, result: 'PASS', snapshot_id: snapshotId, verification: 'RESTIC_CHECK' };
}

export async function checkRepository(target: TargetConfig, tools: ToolConfig = {}): Promise<void> {
  const result = await execute(target, tools, ['check'], 60 * 60_000);
  assertPassed(result, 'TARGET_CHECK_FAILED', 6, `target ${target.id} check`);
}

export async function listSnapshots(target: TargetConfig, tools: ToolConfig = {}): Promise<unknown> {
  const result = await execute(target, tools, ['snapshots', '--json'], 5 * 60_000);
  assertPassed(result, 'TARGET_LIST_FAILED', 3, `target ${target.id} snapshot listing`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new BackupError('TARGET_RECEIPT_INVALID', 3, `target ${target.id} returned invalid snapshot JSON`, 'target');
  }
}

export async function restoreSnapshot(target: TargetConfig, tools: ToolConfig, snapshotId: string, output: string): Promise<void> {
  const result = await execute(target, tools, ['restore', snapshotId, '--target', output], 60 * 60_000);
  assertPassed(result, 'TARGET_RESTORE_FAILED', 6, `target ${target.id} restore`);
}
