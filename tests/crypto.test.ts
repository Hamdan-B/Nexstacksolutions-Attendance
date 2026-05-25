import { describe, expect, it } from 'vitest';
import { decryptText, encryptText } from '../src/shared/crypto';

describe('crypto helpers', () => {
  it('encrypts and decrypts local secrets', () => {
    const secret = 'unit-test-secret';
    const payload = 'sensitive session token';
    const encrypted = encryptText(payload, secret);
    expect(encrypted).not.toBe(payload);
    expect(decryptText(encrypted, secret)).toBe(payload);
  });
});