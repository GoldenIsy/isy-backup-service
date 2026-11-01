import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupReceipt, ImageIdentity, ServiceState } from '../domain/types.js';
import { ensurePrivateDirectory, writeJsonAtomic } from '../runtime/atomic.js';

type Trigger = 'schedule' | 'local-manual' | 'control-plane' | 'recovery';
type SummaryResult = 'PASS' | 'WARN' | 'FAIL' | 'CANCELLED' | 'UNKNOWN';

export interface OperationSummary {
  schema: 'isy.backup.operation-summary/v1';
  operation_id: string;
  kind: 'backup' | 'repository-check' | 'read-data-check' | 'restore-test' | 'retention';
  trigger: Trigger;
  state: SummaryResult;
  code: string;
  command_id: string | null;
  started_at: string;
  completed_at: string | null;
  config_sha256: string;
}

interface SourceSummary {
  id: string;
  type: 'postgresql' | 's3' | 'filesystem';
  required: boolean;
  result: 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED' | 'UNKNOWN';
  bytes: number | null;
  entries: number | null;
  code: string;
}

interface TargetSummary {
  id: string;
  provider_class: 'filesystem' | 's3' | 'rclone';
  required: boolean;
  result: 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED' | 'UNKNOWN';
  snapshot_id: string | null;
  verification: 'NONE' | 'METADATA' | 'READ_DATA' | 'RESTORE_TEST';
  verified_at: string | null;
  code: string;
}

export interface ReceiptSummary {
  schema: 'isy.backup.receipt-summary/v1';
  cursor: string;
  operation: OperationSummary;
  backup_set_id: string;
  result: SummaryResult;
  image: ImageIdentity;
  sources: SourceSummary[];
  targets: TargetSummary[];
  finding_codes: string[];
}

export interface ReceiptPage {
  schema: 'isy.backup.receipt-page/v1';
  after: string | null;
  next: string | null;
  receipts: ReceiptSummary[];
}

export interface Observation {
  schema: 'isy.backup.observation/v1';
  installation_id: string;
  deployment: string;
  environment: string;
  runtime_instance_id: string;
  sequence: number;
  observed_at: string;
  config_sha256: string;
  image: ImageIdentity;
  state: 'READY' | 'DEGRADED' | 'FAILED';
  scheduler_responsive: boolean;
  current_operation_id: string | null;
  next_backup_at: string | null;
  last_attempt_at: string | null;
  last_required_success_at: string | null;
  target_freshness: Record<string, string>;
  finding_codes: string[];
  capabilities: string[];
  update: {
    state: 'CURRENT' | 'AVAILABLE' | 'REQUIRED' | 'UNKNOWN';
    available_version: string | null;
    available_digest: string | null;
  };
}

interface ObservationInput {
  installationId: string;
  deployment: string;
  environment: string;
  runtimeInstanceId: string;
  sequence: number;
  observedAt: Date;
  configSha256: string;
  image: ImageIdentity;
  serviceState: Observation['state'];
  schedulerResponsive: boolean;
  currentOperationId: string | null;
  nextBackupAt: string | null;
  status: {
    last_attempt_at?: string | null;
    last_required_success_at?: string | null;
    target_freshness?: Record<string, string>;
    finding_codes?: string[];
  };
  capabilities: string[];
  update: Observation['update'];
}

function safeCode(value: string | undefined, fallback: string): string {
  return value && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : fallback;
}

function sourceType(type: BackupReceipt['sources'][number]['type']): SourceSummary['type'] {
  return type === 'postgres' ? 'postgresql' : type;
}

function providerClass(type: BackupReceipt['targets'][number]['type']): TargetSummary['provider_class'] {
  if (type === 'filesystem') return 'filesystem';
  if (type === 's3') return 's3';
  return 'rclone';
}

function verification(value: BackupReceipt['targets'][number]['verification']): TargetSummary['verification'] {
  if (value === 'RESTIC_READ_DATA') return 'READ_DATA';
  if (value === 'RESTIC_CHECK') return 'METADATA';
  return 'NONE';
}

export function buildBackupReceiptSummary(
  receipt: BackupReceipt,
  trigger: Trigger,
  cursor: string,
): ReceiptSummary {
  return {
    schema: 'isy.backup.receipt-summary/v1',
    cursor,
    operation: {
      schema: 'isy.backup.operation-summary/v1',
      operation_id: receipt.backup_set_id,
      kind: 'backup',
      trigger,
      state: receipt.result,
      code: `BACKUP_${receipt.result}`,
      command_id: null,
      started_at: receipt.started_at,
      completed_at: receipt.completed_at,
      config_sha256: receipt.config_sha256,
    },
    backup_set_id: receipt.backup_set_id,
    result: receipt.result,
    image: {
      version: receipt.image.version,
      source_revision: receipt.image.source_revision,
      digest: receipt.image.digest,
    },
    sources: receipt.sources.slice(0, 32).map((source) => ({
      id: source.id,
      type: sourceType(source.type),
      required: source.required,
      result: source.result,
      bytes: Number.isSafeInteger(source.bytes) && source.bytes >= 0 ? source.bytes : null,
      entries: source.entries !== undefined && Number.isSafeInteger(source.entries) && source.entries >= 0
        ? source.entries
        : null,
      code: safeCode(source.finding?.code, `SOURCE_${source.result}`),
    })),
    targets: receipt.targets.slice(0, 16).map((target) => ({
      id: target.id,
      provider_class: providerClass(target.type),
      required: target.required,
      result: target.result,
      snapshot_id: target.snapshot_id,
      verification: verification(target.verification),
      verified_at: target.result === 'PASS' ? receipt.completed_at : null,
      code: safeCode(target.finding?.code, `TARGET_${target.result}`),
    })),
    finding_codes: [...new Set(receipt.findings.map((finding) => safeCode(finding.code, 'UNKNOWN_FINDING')))]
      .sort()
      .slice(0, 64),
  };
}

export function buildObservation(input: ObservationInput): Observation {
  return {
    schema: 'isy.backup.observation/v1',
    installation_id: input.installationId,
    deployment: input.deployment,
    environment: input.environment,
    runtime_instance_id: input.runtimeInstanceId,
    sequence: input.sequence,
    observed_at: input.observedAt.toISOString(),
    config_sha256: input.configSha256,
    image: { ...input.image },
    state: input.serviceState,
    scheduler_responsive: input.schedulerResponsive,
    current_operation_id: input.currentOperationId,
    next_backup_at: input.nextBackupAt,
    last_attempt_at: input.status.last_attempt_at ?? null,
    last_required_success_at: input.status.last_required_success_at ?? null,
    target_freshness: { ...(input.status.target_freshness ?? {}) },
    finding_codes: [...new Set(input.status.finding_codes ?? [])].sort().slice(0, 64),
    capabilities: [...new Set(input.capabilities)].sort().slice(0, 32),
    update: { ...input.update },
  };
}

function requiredEvidencePassed(summary: ReceiptSummary): boolean {
  return summary.sources.every((source) => !source.required || source.result === 'PASS')
    && summary.targets.every((target) => !target.required || target.result === 'PASS');
}

export function selectProtectedReceiptCursors(summaries: readonly ReceiptSummary[]): Set<string> {
  const evidenceTime = (summary: ReceiptSummary): string => summary.operation.completed_at ?? summary.operation.started_at;
  const ordered = [...summaries].sort((a, b) => evidenceTime(a).localeCompare(evidenceTime(b)));
  const protectedCursors = new Set<string>();
  const newestFirst = [...ordered].reverse();
  const latestRequiredSuccess = newestFirst.find((summary) => requiredEvidencePassed(summary));
  if (latestRequiredSuccess) protectedCursors.add(latestRequiredSuccess.cursor);
  const latestRestoreTest = newestFirst.find((summary) => summary.operation.kind === 'restore-test');
  if (latestRestoreTest) protectedCursors.add(latestRestoreTest.cursor);
  const latestFailure = newestFirst.find((summary) => summary.result === 'FAIL' || summary.result === 'UNKNOWN');
  if (
    latestFailure
    && (!latestRequiredSuccess || evidenceTime(latestFailure) > evidenceTime(latestRequiredSuccess))
  ) {
    protectedCursors.add(latestFailure.cursor);
  }
  return protectedCursors;
}

function parseJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function receiptNumber(cursor: string): number {
  const match = /^r([0-9a-z]{13})$/u.exec(cursor);
  if (!match?.[1]) return -1;
  return Number.parseInt(match[1], 36);
}

export class EvidenceStore {
  readonly #root: string;
  readonly #receiptDirectory: string;

  constructor(stateDirectory: string) {
    this.#root = path.join(stateDirectory, 'evidence');
    this.#receiptDirectory = path.join(this.#root, 'receipts');
    ensurePrivateDirectory(this.#receiptDirectory);
  }

  runtimeIdentity(): { runtime_instance_id: string } {
    const file = path.join(this.#root, 'runtime.json');
    if (fs.existsSync(file)) return parseJson<{ runtime_instance_id: string }>(file);
    const identity = { runtime_instance_id: crypto.randomUUID() };
    writeJsonAtomic(file, identity);
    return identity;
  }

  nextObservationSequence(): number {
    const file = path.join(this.#root, 'observation-sequence.json');
    const previous = fs.existsSync(file) ? parseJson<{ sequence: number }>(file).sequence : 0;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
      throw new Error('invalid persisted observation sequence');
    }
    const sequence = previous + 1;
    writeJsonAtomic(file, { sequence });
    return sequence;
  }

  publishObservation(observation: Observation): void {
    writeJsonAtomic(path.join(this.#root, 'current-observation.json'), observation);
  }

  currentObservation(): Observation | null {
    const file = path.join(this.#root, 'current-observation.json');
    return fs.existsSync(file) ? parseJson<Observation>(file) : null;
  }

  #summaries(): ReceiptSummary[] {
    return fs.readdirSync(this.#receiptDirectory)
      .filter((name) => /^r[0-9a-z]{13}\.json$/u.test(name))
      .sort()
      .map((name) => parseJson<ReceiptSummary>(path.join(this.#receiptDirectory, name)));
  }

  recordBackup(receipt: BackupReceipt, trigger: Trigger): ReceiptSummary {
    const existing = this.#summaries().find((summary) => summary.backup_set_id === receipt.backup_set_id);
    if (existing) throw new Error(`receipt summary for ${receipt.backup_set_id} already exists`);
    const summaries = this.#summaries();
    const next = (summaries.at(-1) ? receiptNumber(summaries.at(-1)?.cursor ?? '') : 0) + 1;
    if (!Number.isSafeInteger(next) || next <= 0) throw new Error('receipt cursor exhausted');
    const cursor = `r${next.toString(36).padStart(13, '0')}`;
    const summary = buildBackupReceiptSummary(receipt, trigger, cursor);
    const file = path.join(this.#receiptDirectory, `${cursor}.json`);
    const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return summary;
  }

  recordCommandOperation(input: {
    operationId: string; kind: 'backup' | 'repository-check' | 'read-data-check' | 'restore-test' | 'retention'; commandId: string | null;
    trigger?: Trigger;
    state: SummaryResult; code: string; startedAt: string; completedAt: string;
    configSha256: string; image: ImageIdentity; targets: TargetSummary[];
  }): ReceiptSummary {
    const existing = this.#summaries().find((summary) => summary.operation.operation_id === input.operationId);
    if (existing) return existing;
    const summaries = this.#summaries();
    const next = (summaries.at(-1) ? receiptNumber(summaries.at(-1)?.cursor ?? '') : 0) + 1;
    const cursor = `r${next.toString(36).padStart(13, '0')}`;
    const summary: ReceiptSummary = {
      schema: 'isy.backup.receipt-summary/v1', cursor,
      operation: {
        schema: 'isy.backup.operation-summary/v1', operation_id: input.operationId,
        kind: input.kind, trigger: input.trigger ?? 'control-plane', state: input.state, code: input.code,
        command_id: input.commandId, started_at: input.startedAt, completed_at: input.completedAt,
        config_sha256: input.configSha256,
      },
      backup_set_id: input.operationId, result: input.state, image: { ...input.image },
      sources: [], targets: input.targets,
      finding_codes: input.state === 'PASS' || input.state === 'CANCELLED' ? [] : [input.code],
    };
    const file = path.join(this.#receiptDirectory, `${cursor}.json`);
    const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try { fs.writeFileSync(descriptor, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    return summary;
  }

  listReceipts(after: string | null, limit: number): ReceiptPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('receipt page limit must be between 1 and 100');
    const summaries = this.#summaries();
    let start = 0;
    if (after !== null) {
      const index = summaries.findIndex((summary) => summary.cursor === after);
      if (index < 0) throw new Error('unknown receipt cursor');
      start = index + 1;
    }
    const receipts = summaries.slice(start, start + limit);
    const hasMore = start + receipts.length < summaries.length;
    return {
      schema: 'isy.backup.receipt-page/v1',
      after,
      next: hasMore ? receipts.at(-1)?.cursor ?? null : null,
      receipts,
    };
  }

  operation(operationId: string): ReceiptSummary | null {
    return this.#summaries().find((summary) => summary.operation.operation_id === operationId) ?? null;
  }

  latestReceipt(predicate: (summary: ReceiptSummary) => boolean): ReceiptSummary | null {
    const summaries = this.#summaries();
    for (let index = summaries.length - 1; index >= 0; index -= 1) {
      const summary = summaries[index];
      if (summary && predicate(summary)) return summary;
    }
    return null;
  }

  pruneReceipts(maximum: number): { removed: number; retained: number; protected: number } {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('retention maximum must be a positive integer');
    const summaries = this.#summaries();
    const protectedCursors = selectProtectedReceiptCursors(summaries);
    const target = Math.max(maximum, protectedCursors.size);
    let removeCount = Math.max(0, summaries.length - target);
    let removed = 0;
    for (const summary of summaries) {
      if (removeCount === 0) break;
      if (protectedCursors.has(summary.cursor)) continue;
      fs.unlinkSync(path.join(this.#receiptDirectory, `${summary.cursor}.json`));
      removeCount -= 1;
      removed += 1;
    }
    return { removed, retained: summaries.length - removed, protected: protectedCursors.size };
  }
}

export function observationState(state: ServiceState): Observation['state'] {
  if (state === 'DEGRADED' || state === 'STARTING') return 'DEGRADED';
  if (state === 'STOPPING') return 'FAILED';
  return 'READY';
}
