#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkRepository, initializeRepository, listSnapshots } from '../adapters/targets/restic.js';
import { loadConfig } from '../config/load.js';
import { BackupError, errorMessage } from '../domain/errors.js';
import { runBackup } from '../operations/backup.js';
import { doctor } from '../operations/doctor.js';
import { runRestore } from '../operations/restore.js';
import { imageIdentity } from '../runtime/version.js';

function option(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new BackupError('INVOCATION_INVALID', 2, `${name} is required`, 'invocation');
  return value;
}

function configPath(): string {
  return path.resolve(option('--config') ?? '');
}

function targetById(config: ReturnType<typeof loadConfig>['config'], id: string | undefined) {
  const target = config.targets.find((candidate) => candidate.id === id);
  if (!target) throw new BackupError('INVOCATION_INVALID', 2, 'configured --target is required', 'invocation');
  return target;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<number> {
  const [command, subcommand] = process.argv.slice(2);
  if (command === 'version') {
    emit({ schema: 'isy.backup.version/v1', ...imageIdentity(), node: process.version });
    return 0;
  }
  if (command === 'config' && subcommand === 'validate') {
    const loaded = loadConfig(configPath());
    emit({ schema: 'isy.backup.config-validation/v1', result: 'PASS', config_sha256: loaded.sha256 });
    return 0;
  }
  const loaded = loadConfig(configPath());
  if (command === 'doctor') {
    const result = await doctor(loaded.config);
    emit({ schema: 'isy.backup.doctor/v1', ...result });
    return result.result === 'PASS' ? 0 : 3;
  }
  if (command === 'backup') {
    const receipt = await runBackup(loaded);
    emit(receipt);
    if (receipt.result === 'PASS' || receipt.result === 'WARN') return 0;
    return receipt.sources.some((source) => source.required && source.result === 'FAIL') ? 4 : 5;
  }
  if (command === 'repository' && subcommand === 'init') {
    const target = targetById(loaded.config, option('--target'));
    await initializeRepository(target, loaded.config.tools);
    emit({ schema: 'isy.backup.repository-operation/v1', operation: 'init', target: target.id, result: 'PASS' });
    return 0;
  }
  if (command === 'check') {
    const target = targetById(loaded.config, option('--target'));
    await checkRepository(target, loaded.config.tools);
    emit({ schema: 'isy.backup.repository-operation/v1', operation: 'check', target: target.id, result: 'PASS' });
    return 0;
  }
  if (command === 'snapshots') {
    const target = targetById(loaded.config, option('--target'));
    emit({ schema: 'isy.backup.snapshots/v1', target: target.id, snapshots: await listSnapshots(target, loaded.config.tools) });
    return 0;
  }
  if (command === 'restore') {
    const target = targetById(loaded.config, option('--target'));
    await runRestore(loaded.config, target, option('--snapshot') ?? '', option('--output') ?? '');
    emit({ schema: 'isy.backup.restore/v1', target: target.id, snapshot: option('--snapshot'), output: option('--output'), result: 'PASS' });
    return 0;
  }
  if (command === 'status') {
    const statusFile = path.join(loaded.config.state_directory, 'status.json');
    if (!fs.existsSync(statusFile)) throw new BackupError('STATUS_UNAVAILABLE', 3, 'no completed backup status exists', 'status');
    emit(JSON.parse(fs.readFileSync(statusFile, 'utf8')));
    return 0;
  }
  throw new BackupError('INVOCATION_INVALID', 2, 'unknown command', 'invocation');
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  const code = error instanceof BackupError ? error.exitCode : 1;
  emit({ schema: 'isy.backup.error/v1', result: 'FAIL', code: error instanceof BackupError ? error.code : 'INTERNAL_ERROR', detail: errorMessage(error).slice(0, 4096) });
  process.exitCode = code;
});
