import { spawn } from 'node:child_process';
import { BackupError } from '../domain/errors.js';

const MAX_OUTPUT = 64 * 1024;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCommandOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  redact?: (value: string) => string;
}

function appendBounded(existing: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (existing.length >= MAX_OUTPUT) return existing;
  return Buffer.concat([existing, chunk.subarray(0, MAX_OUTPUT - existing.length)]);
}

export async function runCommand(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...options.env
  };
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, options.timeoutMs ?? 300_000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new BackupError('DEPENDENCY_UNAVAILABLE', 3, `cannot execute ${command}: ${error.message}`, 'preflight'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const redact = options.redact ?? ((value: string) => value);
      const result = {
        stdout: redact(stdout.toString('utf8')),
        stderr: redact(stderr.toString('utf8')),
        exitCode: code ?? (signal ? 128 : 1)
      };
      if (timedOut) reject(new BackupError('COMMAND_TIMEOUT', 3, `${command} exceeded its deadline`, 'runtime'));
      else resolve(result);
    });
  });
}
