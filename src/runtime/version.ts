import type { ImageIdentity } from '../domain/types.js';

const VERSION = process.env.ISY_BACKUP_VERSION ?? '0.1.0';
const SOURCE_REVISION = process.env.ISY_BACKUP_SOURCE_REVISION ?? 'development';
const configuredDigest = process.env.ISY_BACKUP_IMAGE_DIGEST ?? '';

export function imageIdentity(): ImageIdentity {
  return {
    version: VERSION,
    source_revision: SOURCE_REVISION,
    digest: /^sha256:[a-f0-9]{64}$/u.test(configuredDigest) ? configuredDigest : null
  };
}
