import { describe, expect, it } from 'vitest';
import { loginRequestSchema, manualCorrectionSchema } from '../src/shared/validation';

describe('validation schemas', () => {
  it('accepts a valid login payload', () => {
    const result = loginRequestSchema.safeParse({
      employeeId: 'EMP001',
      machineInfo: {
        machineName: 'WS-01',
        windowsUser: 'opsuser',
        deviceFingerprint: 'fingerprint-value-001',
        ipAddress: '192.168.1.10'
      }
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid manual correction payloads', () => {
    const result = manualCorrectionSchema.safeParse({
      adminId: 'ADMIN001',
      employeeId: 'EMP023',
      attendanceDate: '2026-05-22',
      oldValue: 'Late',
      newValue: 'Present',
      reason: 'ok',
      machineInfo: {
        machineName: 'WS-01',
        windowsUser: 'opsuser',
        deviceFingerprint: 'fingerprint-value-001',
        ipAddress: '192.168.1.10'
      }
    });
    expect(result.success).toBe(false);
  });
});