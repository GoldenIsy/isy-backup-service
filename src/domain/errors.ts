export class BackupError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
    readonly phase = 'runtime'
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
