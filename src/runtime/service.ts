import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { BackupError, errorMessage } from '../domain/errors.js';
import type { BackupReceipt, Heartbeat, ServiceConfig, ServiceState } from '../domain/types.js';
import { runBackup } from '../operations/backup.js';
import { doctor } from '../operations/doctor.js';
import { ensurePrivateDirectory, writeJsonAtomic } from './atomic.js';
import { appendJournal } from './journal.js';
import { terminateActiveCommands } from './process.js';
import { imageIdentity } from './version.js';

const TERMINAL_JOURNAL_STATES = new Set(['PASS', 'WARN', 'FAIL', 'INTERRUPTED']);

interface PersistedStatus {
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
  const lock = path.join(stateDirectory, 'locks', 'mutation.lock');
  if (fs.existsSync(lock)) {
    fs.unlinkSync(lock);
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

function writeHeartbeat(loaded: LoadedConfig, runtimeInstanceId: string, runtime: MutableRuntime): Heartbeat {
  const heartbeat = buildHeartbeat(loaded, runtimeInstanceId, runtime);
  writeJsonAtomic(heartbeatFile(loaded.config.state_directory), heartbeat);
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
  const runtimeInstanceId = crypto.randomUUID();
  const releaseServiceLock = acquireServiceLock(loaded, runtimeInstanceId);
  const previousStatus = readStatus(loaded.config.state_directory);
  const runtime: MutableRuntime = {
    sequence: 0,
    state: 'STARTING',
    currentOperationId: null,
    nextBackupAt: null,
    status: previousStatus,
    findingCodes: [...(previousStatus.finding_codes ?? []), ...recoverInterruptedState(loaded.config.state_directory)]
  };
  let heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime);
  let stopping = false;
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    runtime.state = 'STOPPING';
    runtime.nextBackupAt = null;
    terminateActiveCommands();
    heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime);
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);
  let server: http.Server;
  try {
    const dependencyCheck = await doctor(loaded.config);
    if (dependencyCheck.result !== 'PASS') {
      throw new BackupError('DEPENDENCY_UNAVAILABLE', 3, 'service dependency admission failed', 'preflight');
    }
    server = await startHealthServer(service, () => heartbeat);
  } catch (error) {
    process.removeListener('SIGTERM', requestStop);
    process.removeListener('SIGINT', requestStop);
    releaseServiceLock();
    throw error;
  }
  const heartbeatTimer = setInterval(() => {
    heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime);
  }, service.heartbeat_interval_seconds * 1_000);
  heartbeatTimer.unref();
  try {
    runtime.state = runtime.findingCodes.length > 0 ? 'DEGRADED' : 'READY';
    let nextBackup = service.run_on_start
      ? Date.now()
      : Date.now() + service.backup_interval_seconds * 1_000;
    runtime.nextBackupAt = new Date(nextBackup).toISOString();
    heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime);
    while (!stopping) {
      await wait(nextBackup - Date.now(), () => stopping);
      if (stopping) break;
      runtime.state = 'RUNNING';
      runtime.currentOperationId = `scheduled-backup-${new Date().toISOString()}`;
      runtime.nextBackupAt = null;
      heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime);
      let receipt: BackupReceipt | null = null;
      try {
        receipt = await runBackup(loaded);
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
      heartbeat = writeHeartbeat(loaded, runtimeInstanceId, runtime);
    }
  } finally {
    stopping = true;
    clearInterval(heartbeatTimer);
    runtime.state = 'STOPPING';
    runtime.currentOperationId = null;
    runtime.nextBackupAt = null;
    writeHeartbeat(loaded, runtimeInstanceId, runtime);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.removeListener('SIGTERM', requestStop);
    process.removeListener('SIGINT', requestStop);
    releaseServiceLock();
  }
}
