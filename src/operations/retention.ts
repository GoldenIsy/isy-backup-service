import crypto from 'node:crypto';
import path from 'node:path';
import { applyRetention } from '../adapters/targets/restic.js';
import type { LoadedConfig } from '../config/load.js';
import { BackupError } from '../domain/errors.js';
import type { RetentionReceipt, TargetConfig } from '../domain/types.js';
import { EvidenceStore } from '../evidence/store.js';
import { writeJsonAtomic } from '../runtime/atomic.js';
import { acquireLock } from '../runtime/lock.js';
import { imageIdentity } from '../runtime/version.js';

export async function runRetention(loaded: LoadedConfig, target: TargetConfig): Promise<RetentionReceipt> {
  if (!target.retention) {
    throw new BackupError('RETENTION_POLICY_REQUIRED', 2, `target ${target.id} has no retention policy`, 'invocation');
  }
  const operationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const release = acquireLock(loaded.config.state_directory, operationId);
  let result: RetentionReceipt['result'] = 'PASS';
  let code = 'RETENTION_PASS';
  try {
    await applyRetention(target, loaded.config.tools ?? {}, target.retention);
  } catch (error) {
    result = 'FAIL';
    code = error instanceof BackupError ? error.code : 'RETENTION_FAILED';
  } finally {
    release();
  }
  const completedAt = new Date().toISOString();
  const receipt: RetentionReceipt = {
    schema: 'isy.backup.retention-receipt/v1',
    operation: 'retention',
    operation_id: operationId,
    deployment: loaded.config.deployment,
    environment: loaded.config.environment,
    target: target.id,
    result,
    code,
    started_at: startedAt,
    completed_at: completedAt,
    config_sha256: loaded.sha256,
    image: imageIdentity(),
    policy: target.retention
  };
  writeJsonAtomic(path.join(loaded.config.state_directory, 'retention', `${operationId}.json`), receipt);
  new EvidenceStore(loaded.config.state_directory).recordCommandOperation({
    operationId,
    kind: 'retention',
    commandId: null,
    trigger: 'local-manual',
    state: result,
    code,
    startedAt,
    completedAt,
    configSha256: loaded.sha256,
    image: imageIdentity(),
    targets: [{
      id: target.id,
      provider_class: target.type === 'filesystem' ? 'filesystem' : target.type === 's3' ? 's3' : 'rclone',
      required: target.required,
      result,
      snapshot_id: null,
      verification: 'NONE',
      verified_at: result === 'PASS' ? completedAt : null,
      code
    }]
  });
  return receipt;
}
