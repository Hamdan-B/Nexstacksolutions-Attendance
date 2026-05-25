export type Role = 'Employee' | 'Admin';

export type AttendanceStatus = 'Present' | 'Late' | 'Absent';

export interface EmployeeRecord {
  employeeId: string;
  employeeName: string;
  role: Role;
  active: boolean;
}

export interface MachineInfo {
  machineName: string;
  windowsUser: string;
  deviceFingerprint: string;
  ipAddress: string;
}

export interface LoginRequest {
  employeeId: string;
  machineInfo: MachineInfo;
}

export interface AttendanceRecord {
  employeeId: string;
  employeeName: string;
  attendanceDate: string;
  checkedInAt: string | null;
  status: AttendanceStatus;
  equivalentAbsence: number;
  source: 'local' | 'google';
}

export interface AuditLogEntry {
  timestamp: string;
  adminId: string;
  employeeId: string | null;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
  machineName: string;
  windowsUser: string;
  deviceFingerprint: string;
  ipAddress: string;
}

export interface SyncQueuePayload {
  employeeId: string;
  employeeName: string;
  attendanceDate: string;
  checkedInAt: string;
  status: AttendanceStatus;
  source: 'local' | 'manual';
}

export interface SessionState {
  employeeId: string;
  role: Role;
  token: string;
  machineFingerprint: string;
  expiresAt: string;
}

export interface AppStatus {
  currentTimePkt: string;
  shiftStartPkt: string;
  shiftEndPkt: string;
  lateThresholdPkt: string;
  attendanceDate: string;
  isWithinAttendanceWindow: boolean;
  hasCheckedInToday: boolean;
  statusText: string;
}

export interface SystemHealthSnapshot {
  internetAvailable: boolean;
  trustedTimeSource: 'internet' | 'local';
  timeDriftMinutes: number;
  syncQueueDepth: number;
  lastSyncAt: string | null;
  watchdogActive: boolean;
  isCentral: boolean;
  centralHost: string | null;
}