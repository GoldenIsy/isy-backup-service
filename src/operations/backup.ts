import fs from 'node:fs';
import path from 'node:path';
import { captureFilesystem } from '../adapters/sources/filesystem.js';
import { capturePostgres } from '../adapters/sources/postgres.js';
import { captureS3 } from '../adapters/sources/s3.js';
import { snapshot } from '../adapters/targets/restic.js';
import type { LoadedConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { createBackupSetId } from '../domain/identity.js';
import { aggregateResult } from '../domain/results.js';
import type { BackupReceipt, CapturedSource, Finding, SourceConfig, TargetResult } from '../domain/types.js';
import { ensurePrivateDirectory, writeJsonAtomic } from '../runtime/atomic.js';
import { appendJournal } from '../runtime/journal.js';
import { acquireLock } from '../runtime/lock.js';
import { imageIdentity } from '../runtime/version.js';

function finding(code: string, phase: string, detail: string, nextAction: string): Finding {
  return { code, phase, owner: 'isy-backup-agent', detail: detail.slice(0, 4096), next_action: nextAction };
}

async function captureSource(source: SourceConfig, directory: string, config: LoadedConfig): Promise<CapturedSource> {
  ensurePrivateDirectory(directory);
  if (source.type === 'filesystem') return captureFilesystem(source, directory);
  if (source.type === 'postgres') return await capturePostgres(source, directory, config.config.tools);
  return await captureS3(source, directory, config.config.tools);
}

export async function runBackup(loaded: LoadedConfig, now = new Date()): Promise<BackupReceipt> {
  const { config } = loaded;
  const release = acquireLock(config.state_directory);
  const backupSetId = createBackupSetId(config.deployment, now);
  const staging = path.join(config.staging_directory, backupSetId);
  const sources: CapturedSource[] = [];
  const targets: TargetResult[] = [];
  const findings: Finding[] = [];
  ensurePrivateDirectory(staging);
  appendJournal(config.state_directory, backupSetId, 'CREATED', now);
  try {
    appendJournal(config.state_directory, backupSetId, 'PREFLIGHT_PASSED');
    appendJournal(config.state_directory, backupSetId, 'CAPTURE_RUNNING');
    for (const source of config.sources) {
      try {
        sources.push(await captureSource(source, path.join(staging, 'sources', source.id), loaded));
      } catch (error) {
        const itemFinding = finding('SOURCE_CAPTURE_FAILED', 'capture', errorMessage(error), 'Inspect the source dependency and retained staging data.');
        findings.push(itemFinding);
        sources.push({ id: source.id, type: source.type, required: source.required, result: 'FAIL', artifact: null, sha256: null, bytes: 0, finding: itemFinding });
      }
    }
    appendJournal(config.state_directory, backupSetId, 'CAPTURE_VALIDATED');
    const manifest = {
      schema: 'isy.backup.manifest/v1',
      backup_set_id: backupSetId,
      deployment: config.deployment,
      environment: config.environment,
      captured_at: new Date().toISOString(),
      sources
    };
    writeJsonAtomic(path.join(staging, 'manifest.json'), manifest);

    if (!sources.some((source) => source.required && source.result !== 'PASS')) {
      appendJournal(config.state_directory, backupSetId, 'TARGETS_RUNNING');
      for (const target of config.targets) {
        try {
          targets.push(await snapshot(target, config.tools ?? {}, staging, backupSetId));
        } catch (error) {
          const itemFinding = finding('TARGET_SNAPSHOT_FAILED', 'target', errorMessage(error), 'Inspect the target repository and retry only after the cause is resolved.');
          findings.push(itemFinding);
          targets.push({ id: target.id, type: target.type, required: target.required, result: 'FAIL', snapshot_id: null, verification: 'NONE', finding: itemFinding });
        }
      }
      appendJournal(config.state_directory, backupSetId, 'TARGETS_RECORDED');
    }

    appendJournal(config.state_directory, backupSetId, 'FINAL_VALIDATION');
    const result = aggregateResult(sources, targets);
    const completedAt = new Date();
    const receipt: BackupReceipt = {
      schema: 'isy.backup.receipt/v1',
      operation: 'backup',
      deployment: config.deployment,
      environment: config.environment,
      backup_set_id: backupSetId,
      result,
      started_at: now.toISOString(),
      completed_at: completedAt.toISOString(),
      config_sha256: loaded.sha256,
      image: imageIdentity(),
      sources,
      targets,
      findings
    };
    const date = now.toISOString().slice(0, 10);
    writeJsonAtomic(path.join(config.state_directory, 'receipts', date, `${backupSetId}.json`), receipt);
    const statusFile = path.join(config.state_directory, 'status.json');
    let previousStatus: Record<string, unknown> = {};
    if (fs.existsSync(statusFile)) {
      try { previousStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Record<string, unknown>; }
      catch { previousStatus = {}; }
    }
    const requiredPassed = !sources.some((source) => source.required && source.result !== 'PASS')
      && !targets.some((target) => target.required && target.result !== 'PASS');
    const previousFreshness = typeof previousStatus.target_freshness === 'object' && previousStatus.target_freshness !== null
      ? previousStatus.target_freshness as Record<string, string>
      : {};
    const targetFreshness = { ...previousFreshness };
    for (const target of targets) if (target.result === 'PASS') targetFreshness[target.id] = completedAt.toISOString();
    writeJsonAtomic(statusFile, {
      schema: 'isy.backup.status/v1',
      deployment: config.deployment,
      environment: config.environment,
      last_attempt_at: completedAt.toISOString(),
      last_success_at: result === 'PASS' ? completedAt.toISOString() : previousStatus.last_success_at ?? null,
      last_required_success_at: requiredPassed ? completedAt.toISOString() : previousStatus.last_required_success_at ?? null,
      target_freshness: targetFreshness,
      result,
      backup_set_id: backupSetId,
      image: imageIdentity(),
      finding_codes: findings.map((item) => item.code)
    });
    appendJournal(config.state_directory, backupSetId, result, completedAt);
    if (result !== 'FAIL') fs.rmSync(staging, { recursive: true, force: false });
    return receipt;
  } finally {
    release();
  }
}
