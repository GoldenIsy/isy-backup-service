export type Result = 'PASS' | 'WARN' | 'FAIL';

export interface ToolConfig {
  restic?: string;
  rclone?: string;
  pg_dump?: string;
  pg_restore?: string;
  psql?: string;
}

export interface ServiceConfig {
  backup_interval_seconds: number;
  heartbeat_interval_seconds: number;
  run_on_start: boolean;
  listen_address: '127.0.0.1' | '0.0.0.0';
  port: number;
}

export interface ControlConfig {
  enabled: boolean;
  socket: string;
  owner_uid: number;
  group_gid: number;
  mode: string;
  installation_id?: string;
  installation_id_file?: string;
  max_receipt_page_size: number;
  allowed_commands?: Array<'backup' | 'repository-check' | 'read-data-check' | 'restore-test' | 'cancel'>;
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

export interface RetentionPolicy {
  keep_hourly?: number;
  keep_daily?: number;
  keep_weekly?: number;
  keep_monthly?: number;
  keep_yearly?: number;
  keep_within?: string;
}

export interface TargetConfig {
  id: string;
  type: TargetType;
  required: boolean;
  repository: string;
  password_file: string;
  cache_directory: string;
  verification?: 'metadata' | 'read-data';
  retention?: RetentionPolicy;
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
  service?: ServiceConfig;
  control?: ControlConfig;
  restore_test?: {
    enabled: boolean; directory: string; interval_seconds: number; target_id: string;
    postgres_verifier?: { host: string; port: number; username: string; password_file: string; maintenance_database: string; database_prefix: string };
  };
  sources: SourceConfig[];
  targets: TargetConfig[];
}

export type ServiceState = 'STARTING' | 'READY' | 'RUNNING' | 'DEGRADED' | 'STOPPING';

export interface Heartbeat {
  schema: 'isy.backup.heartbeat/v1';
  deployment: string;
  environment: string;
  sequence: number;
  runtime_instance_id: string;
  observed_at: string;
  config_sha256: string;
  image: ImageIdentity;
  state: ServiceState;
  scheduler_responsive: boolean;
  current_operation_id: string | null;
  next_backup_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_required_success_at: string | null;
  target_freshness: Record<string, string>;
  finding_codes: string[];
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
  verification: 'RESTIC_CHECK' | 'RESTIC_READ_DATA' | 'NONE';
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

export interface RetentionReceipt {
  schema: 'isy.backup.retention-receipt/v1';
  operation: 'retention';
  operation_id: string;
  deployment: string;
  environment: string;
  target: string;
  result: 'PASS' | 'FAIL';
  code: string;
  started_at: string;
  completed_at: string;
  config_sha256: string;
  image: ImageIdentity;
  policy: RetentionPolicy;
}
