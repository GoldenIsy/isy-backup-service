import { readSecret } from '../../config/load.js';
import { BackupError } from '../../domain/errors.js';
import type { RetentionPolicy, TargetConfig, TargetResult, ToolConfig } from '../../domain/types.js';
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
    // Child output is already capped by runCommand. Keep complete bounded JSON
    // for machine-readable Restic commands; caller-facing errors are trimmed.
    redact: createRedactor(secrets, 64 * 1024)
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

export async function snapshot(target: TargetConfig, tools: ToolConfig, stagingDirectory: string, backupSetId: string, deployment: string): Promise<TargetResult> {
  const backup = await execute(target, tools, ['backup', stagingDirectory, '--json', '--host', deployment, '--tag', `isy-backup-set:${backupSetId}`]);
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
  const readData = target.verification === 'read-data';
  const check = await execute(target, tools, readData ? ['check', '--read-data'] : ['check'], 60 * 60_000);
  assertPassed(check, 'TARGET_CHECK_FAILED', 6, `target ${target.id} check`);
  return {
    id: target.id,
    type: target.type,
    required: target.required,
    result: 'PASS',
    snapshot_id: snapshotId,
    verification: readData ? 'RESTIC_READ_DATA' : 'RESTIC_CHECK'
  };
}

export async function checkRepository(target: TargetConfig, tools: ToolConfig = {}): Promise<void> {
  const result = await execute(target, tools, ['check'], 60 * 60_000);
  assertPassed(result, 'TARGET_CHECK_FAILED', 6, `target ${target.id} check`);
}

export async function checkRepositoryReadData(target: TargetConfig, tools: ToolConfig = {}): Promise<void> {
  const result = await execute(target, tools, ['check', '--read-data'], 60 * 60_000);
  assertPassed(result, 'TARGET_READ_DATA_CHECK_FAILED', 6, `target ${target.id} read-data check`);
}

export async function listSnapshots(target: TargetConfig, tools: ToolConfig = {}): Promise<unknown> {
  const result = await execute(target, tools, ['snapshots', '--json', '--latest', '100'], 5 * 60_000);
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

export async function forgetSnapshot(target: TargetConfig, tools: ToolConfig, snapshotId: string): Promise<void> {
  if (!/^[a-f0-9]{8,64}$/u.test(snapshotId)) {
    throw new BackupError('SNAPSHOT_ID_INVALID', 2, 'an immutable snapshot identity is required', 'target');
  }
  const result = await execute(target, tools, ['forget', snapshotId, '--prune'], 60 * 60_000);
  assertPassed(result, 'TARGET_FORGET_FAILED', 6, `target ${target.id} snapshot deletion`);
}

export async function applyRetention(target: TargetConfig, tools: ToolConfig, policy: RetentionPolicy): Promise<void> {
  const options: string[] = [];
  const numeric: Array<[keyof RetentionPolicy, string]> = [
    ['keep_hourly', '--keep-hourly'],
    ['keep_daily', '--keep-daily'],
    ['keep_weekly', '--keep-weekly'],
    ['keep_monthly', '--keep-monthly'],
    ['keep_yearly', '--keep-yearly']
  ];
  for (const [name, option] of numeric) {
    const value = policy[name];
    if (typeof value === 'number') options.push(option, String(value));
  }
  if (policy.keep_within) options.push('--keep-within', policy.keep_within);
  // Each deployment owns a dedicated repository. Disable Restic's default
  // host/path grouping because containers and staging paths are ephemeral.
  const result = await execute(target, tools, ['forget', '--prune', '--group-by', '', ...options], 60 * 60_000);
  assertPassed(result, 'TARGET_RETENTION_FAILED', 6, `target ${target.id} retention`);
}
