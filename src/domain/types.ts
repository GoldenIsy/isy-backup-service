export type Result = 'PASS' | 'WARN' | 'FAIL';

export interface ToolConfig {
  restic?: string;
  rclone?: string;
  pg_dump?: string;
  pg_restore?: string;
}

export interface CommonSourceConfig {
  id: string;
  required: boolean;
}

export interface FilesystemSourceConfig extends CommonSourceConfig {
  type: 'filesystem';
  root: string;
}

export interface PostgresSourceConfig extends CommonSourceConfig {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  username: string;
  password_file: string;
}

export interface S3SourceConfig extends CommonSourceConfig {
  type: 's3';
  remote: string;
  config_file: string;
}

export type SourceConfig = FilesystemSourceConfig | PostgresSourceConfig | S3SourceConfig;
export type TargetType = 'filesystem' | 'sftp' | 's3' | 'rest-server' | 'rclone';

export interface TargetConfig {
  id: string;
  type: TargetType;
  required: boolean;
  repository: string;
  password_file: string;
  cache_directory: string;
  environment_secret_files?: Record<string, string>;
  environment_file_references?: Record<string, string>;
}

export interface BackupConfig {
  schema: 'isy.backup.config/v1';
  deployment: string;
  environment: string;
  state_directory: string;
  staging_directory: string;
  tools?: ToolConfig;
  sources: SourceConfig[];
  targets: TargetConfig[];
}

export interface Finding {
  code: string;
  phase: string;
  owner: string;
  detail: string;
  next_action: string;
}

export interface ImageIdentity {
  version: string;
  source_revision: string;
  digest: string | null;
}

export interface CapturedSource {
  id: string;
  type: SourceConfig['type'];
  required: boolean;
  result: Result;
  artifact: string | null;
  sha256: string | null;
  bytes: number;
  entries?: number;
  finding?: Finding;
}

export interface TargetResult {
  id: string;
  type: TargetType;
  required: boolean;
  result: Result;
  snapshot_id: string | null;
  verification: 'RESTIC_CHECK' | 'NONE';
  finding?: Finding;
}

export interface BackupReceipt {
  schema: 'isy.backup.receipt/v1';
  operation: 'backup';
  deployment: string;
  environment: string;
  backup_set_id: string;
  result: Result;
  started_at: string;
  completed_at: string;
  config_sha256: string;
  image: ImageIdentity;
  sources: CapturedSource[];
  targets: TargetResult[];
  findings: Finding[];
}
