import crypto from 'node:crypto';

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createBackupSetId(deployment: string, now: Date, nonce = crypto.randomBytes(16)): string {
  const timestamp = now.toISOString().replace(/[-:]/gu, '').replace('.000', '');
  const identity = sha256(`isy.backup.set/v1\0${deployment}\0${now.toISOString()}\0${nonce.toString('hex')}`);
  return `${deployment}-${timestamp}-${identity.slice(0, 8)}`;
}
