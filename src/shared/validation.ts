import { z } from 'zod';

export const loginRequestSchema = z.object({
  employeeId: z.string().trim().min(1).max(32),
  machineInfo: z.object({
    machineName: z.string().trim().min(1).max(128),
    windowsUser: z.string().trim().min(1).max(128),
    deviceFingerprint: z.string().trim().min(12).max(128),
    ipAddress: z.string().trim().min(1).max(64)
  })
});

export const manualCorrectionSchema = z.object({
  adminId: z.string().trim().min(1).max(32),
  employeeId: z.string().trim().min(1).max(32),
  attendanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  oldValue: z.string().trim().min(1).max(128),
  newValue: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(5).max(500),
  machineInfo: z.object({
    machineName: z.string().trim().min(1).max(128),
    windowsUser: z.string().trim().min(1).max(128),
    deviceFingerprint: z.string().trim().min(12).max(128),
    ipAddress: z.string().trim().min(1).max(64)
  })
});