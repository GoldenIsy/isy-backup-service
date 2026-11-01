import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import { BackupError } from '../domain/errors.js';
import { sha256 } from '../domain/identity.js';
import type { BackupConfig } from '../domain/types.js';

const schemaPath = new URL('../../config/backup-config.schema.json', import.meta.url);
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile<BackupConfig>(schema);

export interface LoadedConfig {
  config: BackupConfig;
  sha256: string;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSeparate(first: string, second: string, description: string): void {
  if (isWithin(first, second) || isWithin(second, first)) {
    throw new BackupError('CONFIG_INVALID', 2, `${description} must not overlap`, 'config');
  }
}

function validateSecretFile(secretPath: string, field: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(secretPath);
  } catch {
    throw new BackupError('SECRET_INVALID', 2, `${field} does not reference a readable file`, 'config');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 64 * 1024) {
    throw new BackupError('SECRET_INVALID', 2, `${field} must be a non-empty regular file of at most 64 KiB`, 'config');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new BackupError('SECRET_INVALID', 2, `${field} must not be accessible by group or other users`, 'config');
  }
  fs.accessSync(secretPath, fs.constants.R_OK);
}

function validateSemantics(config: BackupConfig): void {
  const sourceIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const source of config.sources) {
    if (sourceIds.has(source.id)) throw new BackupError('CONFIG_INVALID', 2, `duplicate source id: ${source.id}`, 'config');
    sourceIds.add(source.id);
    if (source.type === 'postgres') validateSecretFile(source.password_file, `sources.${source.id}.password_file`);
    if (source.type === 's3') {
      validateSecretFile(source.config_file, `sources.${source.id}.config_file`);
      if (/[?&](?:token|password|secret|key)=/iu.test(source.remote)) {
        throw new BackupError('CONFIG_INVALID', 2, `source ${source.id} remote must not embed credentials`, 'config');
      }
    }
    if (source.type === 'filesystem') {
      assertSeparate(source.root, config.state_directory, `source ${source.id} and state_directory`);
      assertSeparate(source.root, config.staging_directory, `source ${source.id} and staging_directory`);
    }
  }
  for (const target of config.targets) {
    if (targetIds.has(target.id)) throw new BackupError('CONFIG_INVALID', 2, `duplicate target id: ${target.id}`, 'config');
    targetIds.add(target.id);
    validateSecretFile(target.password_file, `targets.${target.id}.password_file`);
    assertSeparate(target.cache_directory, config.state_directory, `target ${target.id} cache and state_directory`);
    assertSeparate(target.cache_directory, config.staging_directory, `target ${target.id} cache and staging_directory`);
    for (const [name, secretPath] of Object.entries(target.environment_secret_files ?? {})) {
      validateSecretFile(secretPath, `targets.${target.id}.environment_secret_files.${name}`);
    }
    for (const [name, secretPath] of Object.entries(target.environment_file_references ?? {})) {
      validateSecretFile(secretPath, `targets.${target.id}.environment_file_references.${name}`);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/iu.test(target.repository) || /[?&](?:token|password|secret|key)=/iu.test(target.repository)) {
      throw new BackupError('CONFIG_INVALID', 2, `target ${target.id} repository must not embed credentials`, 'config');
    }
    if (target.type === 'filesystem') {
      if (!path.isAbsolute(target.repository)) {
        throw new BackupError('CONFIG_INVALID', 2, `filesystem target ${target.id} repository must be absolute`, 'config');
      }
      for (const source of config.sources) {
        if (source.type === 'filesystem') assertSeparate(source.root, target.repository, `source ${source.id} and target ${target.id}`);
      }
    }
  }
  if (config.restore_test?.enabled) {
    if (!config.targets.some((target) => target.id === config.restore_test?.target_id)) throw new BackupError('CONFIG_INVALID', 2, 'restore_test target_id is not configured', 'config');
    assertSeparate(config.restore_test.directory, config.state_directory, 'restore_test directory and state_directory');
    assertSeparate(config.restore_test.directory, config.staging_directory, 'restore_test directory and staging_directory');
    for (const source of config.sources) if (source.type === 'filesystem') assertSeparate(config.restore_test.directory, source.root, `restore_test directory and source ${source.id}`);
    for (const target of config.targets) if (target.type === 'filesystem') assertSeparate(config.restore_test.directory, target.repository, `restore_test directory and target ${target.id}`);
    if (config.sources.some((source) => source.type === 'postgres') && !config.restore_test.postgres_verifier) throw new BackupError('CONFIG_INVALID', 2, 'PostgreSQL restore tests require an isolated verifier', 'config');
    if (config.restore_test.postgres_verifier) validateSecretFile(config.restore_test.postgres_verifier.password_file, 'restore_test.postgres_verifier.password_file');
  }
}

export function loadConfig(configPath: string): LoadedConfig {
  if (!path.isAbsolute(configPath)) throw new BackupError('CONFIG_INVALID', 2, 'configuration path must be absolute', 'config');
  let source: string;
  try {
    source = fs.readFileSync(configPath, 'utf8');
  } catch {
    throw new BackupError('CONFIG_INVALID', 2, 'configuration file is not readable', 'config');
  }
  const document = parseDocument(source, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) {
    throw new BackupError('CONFIG_INVALID', 2, `configuration YAML is invalid: ${document.errors[0]?.message ?? 'parse error'}`, 'config');
  }
  const candidate: unknown = document.toJS({ maxAliasCount: 0 });
  if (!validateSchema(candidate)) {
    const detail = validateSchema.errors?.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
    throw new BackupError('CONFIG_INVALID', 2, `configuration schema rejected: ${detail ?? 'unknown error'}`, 'config');
  }
  validateSemantics(candidate);
  return { config: candidate, sha256: sha256(canonicalJson(candidate)) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function readSecret(secretPath: string): string {
  validateSecretFile(secretPath, 'secret file');
  return fs.readFileSync(secretPath, 'utf8').replace(/[\r\n]+$/u, '');
}
