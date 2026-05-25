import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function normalizeSecret(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function createKeyMaterial(secret: string): Buffer {
  return normalizeSecret(secret);
}

export function encryptText(plainText: string, secret: string): string {
  const key = normalizeSecret(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptText(payload: string, secret: string): string {
  const buffer = Buffer.from(payload, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const key = normalizeSecret(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function ensureSecretFile(secretFilePath: string): string {
  if (fs.existsSync(secretFilePath)) {
    return fs.readFileSync(secretFilePath, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretFilePath), { recursive: true });
  fs.writeFileSync(secretFilePath, secret, 'utf8');
  return secret;
}