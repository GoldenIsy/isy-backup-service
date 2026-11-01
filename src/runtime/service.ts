import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { startControlServer, type ControlServerHandle } from '../control/server.js';
import { ControlCommandService, type LocalCommand, type LocalCommandResult } from '../control/commands.js';
import { checkRepository, checkRepositoryReadData } from '../adapters/targets/restic.js';
import { BackupError, errorMessage } from '../domain/errors.js';
import type { BackupReceipt, ControlConfig, Heartbeat, ServiceConfig, ServiceState } from '../domain/types.js';
import { buildObservation, EvidenceStore, observationState } from '../evidence/store.js';
import { runBackup } from '../operations/backup.js';
import { runRestoreTest } from '../operations/restoreTest.js';
import { doctor } from '../operations/doctor.js';
import { ensurePrivateDirectory, writeJsonAtomic } from './atomic.js';
import { appendJournal } from './journal.js';
import { acquireLock, recoverStaleMutationLock } from './lock.js';
import { terminateActiveCommands } from './process.js';
import { imageIdentity } from './version.js';

const TERMINAL_JOURNAL_STATES = new Set(['PASS', 'WARN', 'FAIL', 'CANCELLED', 'INTERRUPTED']);
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function controlInstallationId(control: ControlConfig): string | null {
  if (control.installation_id) return control.installation_id;
  if (!control.installation_id_file) return null;
  try {
    const stat = fs.lstatSync(control.installation_id_file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) return null;
    const value = fs.readFileSync(control.installation_id_file, 'utf8').trim();
    return INSTALLATION_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function enabledControlCommands(loaded: LoadedConfig, control: ControlConfig): LocalCommand['action'][] {
  return (control.allowed_commands ?? []).filter((action) =>
    action !== 'restore-test' || loaded.config.restore_test?.enabled === true);
}

interface PersistedStatus {
  config_sha256?: string;
  last_attempt_at?: string | null;
  last_success_at?: string | null;
  last_required_success_at?: string | null;
  target_freshness?: Record<string, string>;
  finding_codes?: string[];
}

interface MutableRuntime {
  sequence: number;
  state: ServiceState;
  currentOperationId: string | null;
  nextBackupAt: string | null;
  status: PersistedStatus;
  findingCodes: string[];
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readStatus(stateDirectory: string): PersistedStatus {
  return readJsonObject(path.join(stateDirectory, 'status.json')) as PersistedStatus;
}

export function heartbeatFile(stateDirectory: string): string {
  return path.join(stateDirectory, 'heartbeat.json');
}

export function buildHeartbeat(
  loaded: LoadedConfig,
  runtimeInstanceId: string,
  runtime: MutableRuntime,
  observedAt = new Date()
): Heartbeat {
  runtime.sequence += 1;
  return {
    schema: 'isy.backup.heartbeat/v1',
    deployment: loaded.config.deployment,
    environment: loaded.config.environment,
    sequence: runtime.sequence,
    runtime_instance_id: runtimeInstanceId,
    observed_at: observedAt.toISOString(),
    config_sha256: loaded.sha256,
    image: imageIdentity(),
    state: runtime.state,
    scheduler_responsive: runtime.state !== 'STARTING' && runtime.state !== 'STOPPING',
    current_operation_id: runtime.currentOperationId,
    next_backup_at: runtime.nextBackupAt,
    last_attempt_at: runtime.status.last_attempt_at ?? null,
    last_success_at: runtime.status.last_success_at ?? null,
    last_required_success_at: runtime.status.last_required_success_at ?? null,
    target_freshness: runtime.status.target_freshness ?? {},
    finding_codes: [...new Set(runtime.findingCodes)].slice(0, 64)
  };
}

function recoverInterruptedState(stateDirectory: string): string[] {
  const findings: string[] = [];
  if (recoverStaleMutationLock(stateDirectory)) {
    findings.push('INTERRUPTED_LOCK_RECOVERED');
  }
  const journalDirectory = path.join(stateDirectory, 'journal');
  if (!fs.existsSync(journalDirectory)) return findings;
  for (const entry of fs.readdirSync(journalDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(journalDirectory, entry.name);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    let lastState = '';
    try { lastState = String((JSON.parse(lines.at(-1) ?? '{}') as { state?: unknown }).state ?? ''); }
    catch { lastState = ''; }
    if (!TERMINAL_JOURNAL_STATES.has(lastState)) {
      appendJournal(stateDirectory, entry.name.slice(0, -'.jsonl'.length), 'INTERRUPTED');
      findings.push('INTERRUPTED_OPERATION_RECOVERED');
    }
  }
  return [...new Set(findings)];
}

function writeHeartbeat(
  loaded: LoadedConfig,
  runtimeInstanceId: string,
  runtime: MutableRuntime,
  evidenceStore: EvidenceStore,
): Heartbeat {
  const heartbeat = buildHeartbeat(loaded, runtimeInstanceId, runtime);
  writeJsonAtomic(heartbeatFile(loaded.config.state_directory), heartbeat);
  const control = loaded.config.control;
  if (control?.enabled) {
    const installationId = controlInstallationId(control);
    if (!installationId) return heartbeat;
    evidenceStore.publishObservation(buildObservation({
      installationId,
      deployment: loaded.config.deployment,
      environment: loaded.config.environment,
      runtimeInstanceId,
      sequence: evidenceStore.nextObservationSequence(),
      observedAt: new Date(heartbeat.observed_at),
      configSha256: loaded.sha256,
      image: heartbeat.image,
      serviceState: observationState(runtime.state),
      schedulerResponsive: heartbeat.scheduler_responsive,
      currentOperationId: runtime.currentOperationId,
      nextBackupAt: runtime.nextBackupAt,
      status: runtime.status,
      capabilities: [
        'backup.history.v1', 'backup.observation.v1',
        ...(enabledControlCommands(loaded, control).map((action) => action === 'backup' ? 'backup.run.v1' : `backup.${action}.v1`)),
      ],
      update: { state: 'UNKNOWN', available_version: null, available_digest: null },
    }));
  }
  return heartbeat;
}

function wait(milliseconds: number, stopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (stopped() || milliseconds <= 0) return resolve();
    let timer: NodeJS.Timeout;
    let poll: NodeJS.Timeout;
    const finish = (): void => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    poll = setInterval(() => {
      if (stopped()) finish();
    }, Math.min(250, milliseconds));
    timer.unref();
    poll.unref();
  });
}

function acquireServiceLock(loaded: LoadedConfig, runtimeInstanceId: string): () => void {
  const directory = path.join(loaded.config.state_directory, 'locks');
  const file = path.join(directory, 'service.lock');
  ensurePrivateDirectory(directory);
  for (;;) {
    try {
      const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, `${runtimeInstanceId}\n`, 'utf8');
      fs.closeSync(descriptor);
      return () => {
        try { fs.unlinkSync(file); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        healthcheck(loaded);
        throw new BackupError('LOCK_UNAVAILABLE', 8, 'another healthy service instance owns this state directory', 'lock');
      } catch (healthError) {
        if (healthError instanceof BackupError && healthError.code === 'LOCK_UNAVAILABLE') throw healthError;
      }
      const stale = `${file}.stale.${crypto.randomUUID()}`;
      try {
        fs.renameSync(file, stale);
        fs.unlinkSync(stale);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
      }
    }
  }
}

function startHealthServer(service: ServiceConfig, current: () => Heartbeat): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const heartbeat = current();
    if (request.method !== 'GET' || !['/health/live', '/health/ready', '/status'].includes(request.url ?? '')) {
      response.writeHead(404).end();
      return;
    }
    const ready = heartbeat.scheduler_responsive;
    const status = request.url === '/health/ready' && !ready ? 503 : 200;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(`${JSON.stringify(heartbeat)}\n`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(service.port, service.listen_address, () => resolve(server));
  });
}

function requireServiceConfig(loaded: LoadedConfig): ServiceConfig {
  if (!loaded.config.service) {
    throw new BackupError('CONFIG_INVALID', 2, 'serve requires the service configuration block', 'config');
  }
  return loaded.config.service;
}

export function healthcheck(loaded: LoadedConfig, now = new Date()): Heartbeat {
  const service = requireServiceConfig(loaded);
  const file = heartbeatFile(loaded.config.state_directory);
  const candidate = readJsonObject(file) as Partial<Heartbeat>;
  const observed = typeof candidate.observed_at === 'string' ? Date.parse(candidate.observed_at) : Number.NaN;
  const maximumAge = Math.max(30, service.heartbeat_interval_seconds * 3) * 1_000;
  if (
    candidate.schema !== 'isy.backup.heartbeat/v1'
    || candidate.config_sha256 !== loaded.sha256
    || candidate.scheduler_responsive !== true
    || !Number.isFinite(observed)
    || now.getTime() - observed > maximumAge
    || observed - now.getTime() > 5_000
  ) {
    throw new BackupError('HEALTHCHECK_FAILED', 3, 'scheduler heartbeat is missing, stale, or does not match configuration', 'health');
  }
  return candidate as Heartbeat;
}

export async function runService(loaded: LoadedConfig): Promise<void> {
  const service = requireServiceConfig(loaded);
  ensurePrivateDirectory(loaded.config.state_directory);
  ensurePrivateDirectory(loaded.config.staging_directory);
  const evidenceStore = new EvidenceStore(loaded.config.state_directory);
  const runtimeInstanceId = evidenceStore.runtimeIdentity().runtime_instance_id;
  const releaseServiceLock = acquireServiceLock(loaded, runtimeInstanceId);
  const persistedStatus = readStatus(loaded.config.state_directory);
  const previousStatus = persistedStatus.config_sha256 === loaded.sha256 ? persistedStatus : {};
  let recoveryFindings: string[];
  try {
    recoveryFindings = recoverInterruptedState(loaded.config.state_directory);
  } catch (error) {
    releaseServiceLock();
    throw error;
  }
  const runtime: MutableRuntime = {
    sequence: 0,
    state: 'STARTING',
    currentOperationId: null,
    nextBackupAt: null,
    status: previousStatus,
    findingCodes: [...(previousStatus.finding_codes ?? []), ...recoveryFindings]
  };
  let heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
  let stopping = false;
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    runtime.state = 'STOPPING';
    runtime.nextBackupAt = null;
    terminateActiveCommands();
    heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);
  let server: http.Server | undefined;
  let controlServer: ControlServerHandle | undefined;
  try {
    const dependencyCheck = await doctor(loaded.config);
    if (dependencyCheck.result !== 'PASS') {
      throw new BackupError('DEPENDENCY_UNAVAILABLE', 3, 'service dependency admission failed', 'preflight');
    }
    server = await startHealthServer(service, () => heartbeat);
    const control = loaded.config.control;
    if (control?.enabled) {
      const enabledCommands = enabledControlCommands(loaded, control);
      const commandCapabilities = enabledCommands.map((action) => action === 'backup' ? 'backup.run.v1' : `backup.${action}.v1`);
      const executeControlCommand = async (command: LocalCommand, signal: AbortSignal): Promise<LocalCommandResult> => {
        if (command.action === 'cancel') throw new BackupError('COMMAND_INVALID', 2, 'cancel commands are handled by command admission', 'control');
        const startedAt = new Date().toISOString();
        const terminate = (): void => terminateActiveCommands();
        signal.addEventListener('abort', terminate, { once: true });
        runtime.state = 'RUNNING'; runtime.currentOperationId = command.command_id;
        heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
        let operationId: string | null = command.command_id; let receiptCursor: string | null = null;
        let state: LocalCommandResult['state'] = 'SUCCEEDED'; let code = 'COMMAND_SUCCEEDED';
        try {
          if (command.action === 'backup') {
            const receipt = await runBackup(loaded, new Date(startedAt), 'control-plane', signal);
            operationId = receipt.backup_set_id;
            receiptCursor = evidenceStore.operation(operationId)?.cursor ?? null;
            state = receipt.result === 'FAIL' ? 'FAILED' : 'SUCCEEDED'; code = `BACKUP_${receipt.result}`;
          } else if (command.action === 'restore-test') {
            const summary=await runRestoreTest(loaded,command.command_id,{targetId:String(command.payload.target_id),snapshotId:String(command.payload.snapshot_id)},signal);
            receiptCursor=summary.cursor;operationId=summary.operation.operation_id;state=summary.result==='PASS'?'SUCCEEDED':summary.result==='CANCELLED'?'CANCELLED':'FAILED';code=summary.operation.code;
          } else {
            const targetId = command.payload.target_id;
            const targets = targetId === null
              ? loaded.config.targets
              : loaded.config.targets.filter((target) => target.id === targetId);
            if (targets.length === 0) throw new BackupError('TARGET_NOT_CONFIGURED', 2, 'configured target is required', 'control');
            if (command.action === 'read-data-check' && command.payload.policy !== 'full') {
              throw new BackupError('READ_DATA_POLICY_UNSUPPORTED', 2, 'configured read-data policy is required', 'control');
            }
            const release = acquireLock(loaded.config.state_directory, command.command_id);
            const targetResults: Array<{ id: string; provider_class: 'filesystem' | 's3' | 'rclone'; required: boolean; result: 'PASS' | 'FAIL'; snapshot_id: null; verification: 'METADATA' | 'READ_DATA'; verified_at: string | null; code: string }> = [];
            try {
              for (const target of targets) {
                try {
                  if (command.action === 'repository-check') await checkRepository(target, loaded.config.tools);
                  else await checkRepositoryReadData(target, loaded.config.tools);
                  if (signal.aborted) throw new BackupError('COMMAND_CANCELLED', 7, 'backup operation was cancelled', 'control');
                  targetResults.push({ id: target.id, provider_class: target.type === 'filesystem' ? 'filesystem' : target.type === 's3' ? 's3' : 'rclone', required: target.required, result: 'PASS', snapshot_id: null, verification: command.action === 'repository-check' ? 'METADATA' : 'READ_DATA', verified_at: new Date().toISOString(), code: 'TARGET_CHECK_PASS' });
                } catch {
                  if (signal.aborted) throw new BackupError('COMMAND_CANCELLED', 7, 'backup operation was cancelled', 'control');
                  targetResults.push({ id: target.id, provider_class: target.type === 'filesystem' ? 'filesystem' : target.type === 's3' ? 's3' : 'rclone', required: target.required, result: 'FAIL', snapshot_id: null, verification: command.action === 'repository-check' ? 'METADATA' : 'READ_DATA', verified_at: null, code: 'TARGET_CHECK_FAIL' });
                }
              }
            } finally { release(); }
            const requiredFailed = targetResults.some((target) => target.required && target.result === 'FAIL');
            const optionalFailed = targetResults.some((target) => !target.required && target.result === 'FAIL');
            const summaryState = requiredFailed ? 'FAIL' : optionalFailed ? 'WARN' : 'PASS';
            code = command.action === 'repository-check' ? `REPOSITORY_CHECK_${summaryState}` : `READ_DATA_CHECK_${summaryState}`;
            const summary = evidenceStore.recordCommandOperation({ operationId: command.command_id, kind: command.action, commandId: command.command_id, state: summaryState, code, startedAt, completedAt: new Date().toISOString(), configSha256: loaded.sha256, image: imageIdentity(), targets: targetResults });
            receiptCursor = summary.cursor; state = requiredFailed ? 'FAILED' : 'SUCCEEDED';
          }
        } catch (error) {
          state = signal.aborted ? 'CANCELLED' : 'FAILED';
          code = signal.aborted ? 'COMMAND_CANCELLED' : error instanceof BackupError ? error.code : 'COMMAND_FAILED';
          if (signal.aborted && !receiptCursor) {
            const summary = evidenceStore.recordCommandOperation({ operationId: command.command_id,
              kind: command.action, commandId: command.command_id, state: 'CANCELLED', code,
              startedAt, completedAt: new Date().toISOString(), configSha256: loaded.sha256,
              image: imageIdentity(), targets: [] });
            operationId = summary.operation.operation_id; receiptCursor = summary.cursor;
          }
        } finally {
          signal.removeEventListener('abort', terminate);
          runtime.currentOperationId = null; runtime.status = readStatus(loaded.config.state_directory);
          runtime.state = state === 'SUCCEEDED' || state === 'CANCELLED' ? 'READY' : 'DEGRADED';
          heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
        }
        return { schema: 'isy.backup.command-result/v1', command_id: command.command_id,
          idempotency_key: command.idempotency_key, command_digest: command.command_digest,
          state, code, operation_id: operationId, receipt_cursor: receiptCursor,
          started_at: startedAt, completed_at: new Date().toISOString() };
      };
      const commandService = new ControlCommandService({
        stateDirectory: loaded.config.state_directory, installationId: () => controlInstallationId(control),
        configSha256: loaded.sha256, allowedCommands: enabledCommands,
        capabilities: commandCapabilities, execute: executeControlCommand,
      });
      controlServer = await startControlServer({
        socketPath: control.socket,
        ownerUid: control.owner_uid,
        groupGid: control.group_gid,
        mode: control.mode,
        maximumReceiptPageSize: control.max_receipt_page_size,
        evidenceStore,
        commandService,
      });
    }
  } catch (error) {
    process.removeListener('SIGTERM', requestStop);
    process.removeListener('SIGINT', requestStop);
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    releaseServiceLock();
    throw error;
  }
  const heartbeatTimer = setInterval(() => {
    heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
  }, service.heartbeat_interval_seconds * 1_000);
  heartbeatTimer.unref();
  try {
    runtime.state = runtime.findingCodes.length > 0 ? 'DEGRADED' : 'READY';
    let nextBackup = service.run_on_start
      ? Date.now()
      : Date.now() + service.backup_interval_seconds * 1_000;
    runtime.nextBackupAt = new Date(nextBackup).toISOString();
    heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
    while (!stopping) {
      await wait(nextBackup - Date.now(), () => stopping);
      if (stopping) break;
      runtime.state = 'RUNNING';
      runtime.currentOperationId = `scheduled-backup-${new Date().toISOString()}`;
      runtime.nextBackupAt = null;
      heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
      let receipt: BackupReceipt | null = null;
      try {
        receipt = await runBackup(loaded, new Date(), 'schedule');
        runtime.status = readStatus(loaded.config.state_directory);
        runtime.findingCodes = receipt.findings.map((finding) => finding.code);
      } catch (error) {
        runtime.findingCodes = ['SCHEDULED_BACKUP_ERROR'];
        process.stderr.write(`${JSON.stringify({ schema: 'isy.backup.service-error/v1', code: 'SCHEDULED_BACKUP_ERROR', detail: errorMessage(error).slice(0, 4096) })}\n`);
      }
      runtime.currentOperationId = null;
      runtime.state = receipt?.result === 'PASS' && runtime.findingCodes.length === 0 ? 'READY' : 'DEGRADED';
      nextBackup = Date.now() + service.backup_interval_seconds * 1_000;
      runtime.nextBackupAt = new Date(nextBackup).toISOString();
      heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
      if (loaded.config.restore_test?.enabled) {
        const recent=evidenceStore.latestReceipt((item)=>item.operation.kind==='restore-test');
        const last=recent?.operation.completed_at?Date.parse(recent.operation.completed_at):0;
        if(Date.now()-last>=loaded.config.restore_test.interval_seconds*1000){
          try{const result=await runRestoreTest(loaded);runtime.findingCodes=result.result==='PASS'
            ?runtime.findingCodes.filter((code)=>code!=='RESTORE_TEST_FAILED')
            :[...new Set([...runtime.findingCodes,result.operation.code])];}
          catch(error){runtime.findingCodes=[...new Set([...runtime.findingCodes,error instanceof BackupError?error.code:'RESTORE_TEST_FAILED'])];}
          runtime.state=runtime.findingCodes.length===0?'READY':'DEGRADED';
          heartbeat=writeHeartbeat(loaded,runtimeInstanceId,runtime,evidenceStore);
        }
      }
    }
  } finally {
    stopping = true;
    clearInterval(heartbeatTimer);
    runtime.state = 'STOPPING';
    runtime.currentOperationId = null;
    runtime.nextBackupAt = null;
    writeHeartbeat(loaded, runtimeInstanceId, runtime, evidenceStore);
    if (controlServer) await controlServer.close();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    process.removeListener('SIGTERM', requestStop);
    process.removeListener('SIGINT', requestStop);
    releaseServiceLock();
  }
}
