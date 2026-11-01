import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError } from '../domain/errors.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const files = [
  ['compose.example.yml', 'compose.yml'],
  ['config/backup-config.example.yml', 'config.yml'],
  ['config/providers/pcloud-eu.example.yml', 'providers/pcloud-eu.example.yml'],
  ['docs/ON_PREMISE_DEPLOYMENT.md', 'README.md'],
  ['scripts/put-secret.sh', 'scripts/put-secret.sh']
] as const;

export function exportDeployment(output: string): string[] {
  const destination = path.resolve(output);
  const existing = files
    .map(([, target]) => path.join(destination, target))
    .filter((target) => fs.existsSync(target));
  if (existing.length > 0) {
    throw new BackupError('DEPLOYMENT_EXPORT_EXISTS', 2, `deployment file already exists: ${existing[0]}`, 'invocation');
  }

  const written: string[] = [];
  for (const [source, target] of files) {
    const sourcePath = path.join(repositoryRoot, source);
    const targetPath = path.join(destination, target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(targetPath, target.endsWith('.sh') ? 0o755 : 0o644);
    written.push(target);
  }
  for (const directory of ['agent', 'secrets']) {
    fs.mkdirSync(path.join(destination, directory), { recursive: true, mode: directory === 'secrets' ? 0o700 : 0o755 });
  }
  return written;
}
