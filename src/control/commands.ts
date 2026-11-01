import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ensurePrivateDirectory, writeJsonAtomic } from '../runtime/atomic.js';

export type LocalCommandAction = 'backup' | 'repository-check' | 'read-data-check' | 'restore-test' | 'cancel';
export interface LocalCommand {
  schema: 'isy.backup.command/v1'; command_id: string; idempotency_key: string;
  installation_id: string; command_digest: string; action: LocalCommandAction;
  payload: Record<string, unknown>; expected_config_sha256: string;
  required_capability: string; issued_at: string; expires_at: string;
}
export interface LocalCommandResult {
  schema: 'isy.backup.command-result/v1'; command_id: string; idempotency_key: string;
  command_digest: string; state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN'; code: string;
  operation_id: string | null; receipt_cursor: string | null; started_at: string; completed_at: string;
}
interface RecordValue { command: LocalCommand; state: 'ADMITTED' | 'FINAL'; result: LocalCommandResult | null; }

const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/control/v1/protocol.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat('date-time', { type: 'string', validate: (value: string) => value.endsWith('Z') && Number.isFinite(Date.parse(value)) });
ajv.addSchema(schema);
const validate = ajv.compile<LocalCommand>({ $ref: 'https://schemas.isyreport.de/isy-backup/control/v1/protocol.schema.json#/$defs/command' });

export class CommandAdmissionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class ControlCommandService {
  readonly #directory: string;
  readonly #active = new Map<string, AbortController>();
  constructor(private readonly options: {
    stateDirectory: string; installationId: string | (() => string | null); configSha256: string;
    allowedCommands: LocalCommandAction[]; capabilities: string[];
    execute: (command: LocalCommand, signal: AbortSignal) => Promise<LocalCommandResult>;
    now?: () => number;
  }) {
    this.#directory = path.join(options.stateDirectory, 'control-commands');
    ensurePrivateDirectory(this.#directory);
  }
  #file(commandId: string): string { return path.join(this.#directory, `${commandId}.json`); }
  async submit(value: unknown): Promise<LocalCommandResult> {
    if (!validate(value)) throw new CommandAdmissionError('COMMAND_INVALID');
    const command = value;
    const file = this.#file(command.command_id);
    if (fs.existsSync(file)) {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as RecordValue;
      if (previous.command.command_digest !== command.command_digest || previous.command.idempotency_key !== command.idempotency_key) {
        throw new CommandAdmissionError('COMMAND_REPLAY_CONFLICT');
      }
      if (previous.result) return previous.result;
      throw new CommandAdmissionError('COMMAND_OUTCOME_UNKNOWN');
    }
    const now = (this.options.now ?? Date.now)();
    const installationId = typeof this.options.installationId === 'function'
      ? this.options.installationId()
      : this.options.installationId;
    if (!installationId) throw new CommandAdmissionError('INSTALLATION_IDENTITY_UNAVAILABLE');
    if (command.installation_id !== installationId) throw new CommandAdmissionError('INSTALLATION_MISMATCH');
    if (command.expected_config_sha256 !== this.options.configSha256) throw new CommandAdmissionError('CONFIG_DIGEST_MISMATCH');
    if (Date.parse(command.issued_at) > now + 60_000 || Date.parse(command.expires_at) <= now) throw new CommandAdmissionError('COMMAND_EXPIRED');
    if (!this.options.allowedCommands.includes(command.action)) throw new CommandAdmissionError('COMMAND_NOT_ALLOWED');
    if (!this.options.capabilities.includes(command.required_capability)) throw new CommandAdmissionError('CAPABILITY_UNSUPPORTED');
    writeJsonAtomic(file, { command, state: 'ADMITTED', result: null } satisfies RecordValue);
    let result: LocalCommandResult;
    if (command.action === 'cancel') {
      const operationId = String(command.payload.operation_id ?? '');
      const active = this.#active.get(operationId);
      if (active) active.abort();
      const at = new Date(now).toISOString();
      result = {
        schema: 'isy.backup.command-result/v1', command_id: command.command_id,
        idempotency_key: command.idempotency_key, command_digest: command.command_digest,
        state: active ? 'SUCCEEDED' : 'FAILED',
        code: active ? 'CANCELLATION_REQUESTED' : 'OPERATION_NOT_RUNNING',
        operation_id: operationId || null, receipt_cursor: null, started_at: at, completed_at: at,
      };
    } else {
      const controller = new AbortController();
      this.#active.set(command.command_id, controller);
      try { result = await this.options.execute(command, controller.signal); }
      finally { this.#active.delete(command.command_id); }
    }
    writeJsonAtomic(file, { command, state: 'FINAL', result } satisfies RecordValue);
    return result;
  }
}
