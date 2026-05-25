import { encryptText, decryptText } from '../shared/crypto';
import type { AttendanceRecord, EmployeeRecord, MachineInfo, SessionState, SystemHealthSnapshot } from '../shared/types';
import { calculateEquivalentAbsence, pktDateString } from '../shared/time';
import type { SqliteStore } from './sqlite';

type DatabaseRow = Record<string, unknown>;

export class NexStackStore {
  constructor(private db: SqliteStore, private readonly secret: string) {}

  setDatabase(db: SqliteStore): void {
    this.db = db;
  }

  private encrypt(value: string): string {
    return encryptText(value, this.secret);
  }

  private decrypt(value: string): string {
    return decryptText(value, this.secret);
  }

  decryptQueuePayload(payloadEncrypted: string): Record<string, unknown> {
    return JSON.parse(this.decrypt(payloadEncrypted)) as Record<string, unknown>;
  }

  seedEmployees(rows: Array<{ employeeId: string; employeeName: string; role: string; active: number; sourceVersion?: string | null }>): void {
    const statement = this.db.prepare(`
      INSERT INTO EmployeeCache (employeeId, employeeName, role, active, assignedDeviceId, sourceVersion, updatedAt)
      VALUES (?, ?, ?, ?, NULL, ?, datetime('now'))
      ON CONFLICT(employeeId) DO UPDATE SET
        employeeName = excluded.employeeName,
        role = excluded.role,
        active = excluded.active,
        assignedDeviceId = NULL,
        sourceVersion = excluded.sourceVersion,
        updatedAt = datetime('now')
    `);
    for (const row of rows) {
      statement.run(row.employeeId, row.employeeName, row.role, row.active, row.sourceVersion ?? 'google');
    }
  }

  getEmployee(employeeId: string): EmployeeRecord | null {
    const row = this.db.prepare('SELECT * FROM EmployeeCache WHERE employeeId = ?').get(employeeId) as DatabaseRow | undefined;
    if (!row) {
      return null;
    }
    return {
      employeeId: String(row.employeeId),
      employeeName: String(row.employeeName),
      role: String(row.role) === 'Admin' ? 'Admin' : 'Employee',
      active: Number(row.active) === 1
    };
  }

  upsertSession(session: SessionState): void {
    const payload = this.encrypt(JSON.stringify(session));
    this.db.prepare(`
      INSERT INTO Session (employeeId, role, tokenEncrypted, machineFingerprint, lastLoginAt, expiresAt)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(session.employeeId, session.role, payload, session.machineFingerprint, session.expiresAt);
  }

  getLatestSession(): SessionState | null {
    const row = this.db.prepare('SELECT * FROM Session ORDER BY id DESC LIMIT 1').get() as DatabaseRow | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(this.decrypt(String(row.tokenEncrypted))) as SessionState;
  }

  clearSession(): void {
    this.db.prepare('DELETE FROM Session').run();
  }

  upsertAttendance(attendance: AttendanceRecord): void {
    this.db.prepare(`
      INSERT INTO AttendanceCache (employeeId, employeeName, attendanceDate, checkedInAt, status, equivalentAbsence, source, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(employeeId, attendanceDate) DO UPDATE SET
        employeeName = excluded.employeeName,
        checkedInAt = excluded.checkedInAt,
        status = excluded.status,
        equivalentAbsence = excluded.equivalentAbsence,
        source = excluded.source,
        updatedAt = datetime('now')
    `).run(
      attendance.employeeId,
      attendance.employeeName,
      attendance.attendanceDate,
      attendance.checkedInAt,
      attendance.status,
      attendance.equivalentAbsence,
      attendance.source
    );
  }

  getAttendance(employeeId: string, attendanceDate: string): AttendanceRecord | null {
    const row = this.db.prepare('SELECT * FROM AttendanceCache WHERE employeeId = ? AND attendanceDate = ?').get(employeeId, attendanceDate) as DatabaseRow | undefined;
    if (!row) {
      return null;
    }
    return {
      employeeId: String(row.employeeId),
      employeeName: String(row.employeeName),
      attendanceDate: String(row.attendanceDate),
      checkedInAt: row.checkedInAt ? String(row.checkedInAt) : null,
      status: String(row.status) as AttendanceRecord['status'],
      equivalentAbsence: Number(row.equivalentAbsence ?? 0),
      source: String(row.source) === 'google' ? 'google' : 'local'
    };
  }

  listAttendance(limit = 200): AttendanceRecord[] {
    const rows = this.db.prepare('SELECT * FROM AttendanceCache ORDER BY attendanceDate DESC, employeeName ASC LIMIT ?').all(limit) as DatabaseRow[];
    return rows.map((row) => ({
      employeeId: String(row.employeeId),
      employeeName: String(row.employeeName),
      attendanceDate: String(row.attendanceDate),
      checkedInAt: row.checkedInAt ? String(row.checkedInAt) : null,
      status: String(row.status) as AttendanceRecord['status'],
      equivalentAbsence: Number(row.equivalentAbsence ?? 0),
      source: String(row.source) === 'google' ? 'google' : 'local'
    }));
  }

  listPendingQueue(): Array<{ id: number; employeeId: string; payloadEncrypted: string; attemptCount: number; nextRetryAt: string | null; syncStatus: string }> {
    return this.db.prepare(`
      SELECT id, employeeId, payloadEncrypted, attemptCount, nextRetryAt, syncStatus
      FROM AttendanceQueue
      WHERE syncStatus <> 'synced'
      ORDER BY id ASC
    `).all() as Array<{ id: number; employeeId: string; payloadEncrypted: string; attemptCount: number; nextRetryAt: string | null; syncStatus: string }>;
  }

  queueAttendance(payload: { employeeId: string; employeeName: string; attendanceDate: string; checkedInAt: string; status: string; source: string }): number {
    const encrypted = this.encrypt(JSON.stringify(payload));
    const result = this.db.prepare(`
      INSERT INTO AttendanceQueue (employeeId, employeeName, attendanceDate, checkedInAt, status, source, payloadEncrypted, syncStatus, attemptCount, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, datetime('now'))
    `).run(payload.employeeId, payload.employeeName, payload.attendanceDate, payload.checkedInAt, payload.status, payload.source, encrypted);
    return Number(result.lastInsertRowid);
  }

  markQueueSynced(id: number, message = 'synced'): void {
    this.db.prepare(`
      UPDATE AttendanceQueue
      SET syncStatus = 'synced', syncedAt = datetime('now'), lastError = NULL, updatedAt = datetime('now')
      WHERE id = ?
    `).run(id);
    this.db.prepare('INSERT INTO SyncLogs (entityType, entityId, action, status, message) VALUES (?, ?, ?, ?, ?)').run('AttendanceQueue', String(id), 'sync', 'success', message);
  }

  markQueueFailed(id: number, errorMessage: string): void {
    this.db.prepare(`
      UPDATE AttendanceQueue
      SET syncStatus = 'failed', attemptCount = attemptCount + 1, lastError = ?, nextRetryAt = datetime('now', '+60 seconds'), updatedAt = datetime('now')
      WHERE id = ?
    `).run(errorMessage, id);
    this.db.prepare('INSERT INTO SyncLogs (entityType, entityId, action, status, message) VALUES (?, ?, ?, ?, ?)').run('AttendanceQueue', String(id), 'sync', 'failed', errorMessage);
  }

  recordAudit(entry: { timestamp: string; adminId: string; employeeId: string | null; action: string; oldValue: string | null; newValue: string | null; reason: string; machineInfo: MachineInfo }): void {
    this.db.prepare(`
      INSERT INTO AuditCache (timestamp, adminId, employeeId, action, oldValue, newValue, reason, machineName, windowsUser, deviceFingerprint, ipAddress)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.timestamp,
      entry.adminId,
      entry.employeeId,
      entry.action,
      entry.oldValue,
      entry.newValue,
      entry.reason,
      entry.machineInfo.machineName,
      entry.machineInfo.windowsUser,
      entry.machineInfo.deviceFingerprint,
      entry.machineInfo.ipAddress
    );
  }

  recordDevice(machineInfo: MachineInfo, employeeId: string | null, assignedDeviceId: string | null, unexpected: boolean): void {
    this.db.prepare(`
      INSERT INTO DeviceInfo (employeeId, machineName, windowsUser, deviceFingerprint, assignedDeviceId, ipAddress, firstSeenAt, lastSeenAt, isUnexpected)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
      ON CONFLICT(deviceFingerprint) DO UPDATE SET
        employeeId = excluded.employeeId,
        machineName = excluded.machineName,
        windowsUser = excluded.windowsUser,
        assignedDeviceId = excluded.assignedDeviceId,
        ipAddress = excluded.ipAddress,
        lastSeenAt = datetime('now'),
        isUnexpected = excluded.isUnexpected
    `).run(employeeId, machineInfo.machineName, machineInfo.windowsUser, machineInfo.deviceFingerprint, assignedDeviceId, machineInfo.ipAddress, unexpected ? 1 : 0);
  }

  setSystemHealth(metric: string, value: string, severity: 'info' | 'warning' | 'critical'): void {
    this.db.prepare('INSERT INTO SystemHealth (metric, value, severity) VALUES (?, ?, ?)').run(metric, value, severity);
  }

  getHealthSnapshot(): SystemHealthSnapshot {
    const rows = this.db.prepare('SELECT metric, value FROM SystemHealth ORDER BY id DESC LIMIT 20').all() as Array<{ metric: string; value: string }>;
    const healthMap = new Map<string, string>();
    for (const row of rows) {
      // Rows are newest-first; keep the first value per metric.
      if (!healthMap.has(row.metric)) {
        healthMap.set(row.metric, row.value);
      }
    }
    const knownCentral = this.listKnownCentrals()[0];
    return {
      internetAvailable: healthMap.get('internetAvailable') === 'true',
      trustedTimeSource: (healthMap.get('trustedTimeSource') as SystemHealthSnapshot['trustedTimeSource']) ?? 'local',
      timeDriftMinutes: Number(healthMap.get('timeDriftMinutes') ?? 0),
      syncQueueDepth: Number(healthMap.get('syncQueueDepth') ?? 0),
      lastSyncAt: healthMap.get('lastSyncAt') ?? null,
      watchdogActive: healthMap.get('watchdogActive') === 'true',
      isCentral: healthMap.get('isCentral') === 'true',
      centralHost: healthMap.get('centralHost') ?? knownCentral?.host ?? null
    };
  }

  saveSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO Settings (key, valueEncrypted, updatedAt)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET valueEncrypted = excluded.valueEncrypted, updatedAt = datetime('now')
    `).run(key, this.encrypt(value));
  }

  loadSetting(key: string): string | null {
    const row = this.db.prepare('SELECT valueEncrypted FROM Settings WHERE key = ?').get(key) as DatabaseRow | undefined;
    return row ? this.decrypt(String(row.valueEncrypted)) : null;
  }

  getLateCount(employeeId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM AttendanceCache
      WHERE employeeId = ? AND status = 'Late'
    `).get(employeeId) as { total?: number } | undefined;
    return Number(row?.total ?? 0);
  }

  getEquivalentAbsence(employeeId: string): number {
    return calculateEquivalentAbsence(this.getLateCount(employeeId));
  }

  getTodayAttendance(employeeId: string, date = pktDateString(new Date())): AttendanceRecord | null {
    return this.getAttendance(employeeId, date);
  }

  // Known centrals are stored as a JSON array in Settings to avoid schema changes.
  addKnownCentral(host: string, port: number): void {
    const raw = this.loadSetting('knownCentrals') ?? '[]';
    let list: Array<{ host: string; port: number; lastSeenAt: string }> = [];
    try {
      list = JSON.parse(raw) as any[];
    } catch {
      list = [];
    }
    const existing = list.find((c) => c.host === host && c.port === port);
    const entry = { host, port, lastSeenAt: new Date().toISOString() };
    if (existing) {
      existing.lastSeenAt = entry.lastSeenAt;
    } else {
      list.push(entry);
    }
    // keep only recent entries (last 50)
    list = list.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1)).slice(0, 50);
    this.saveSetting('knownCentrals', JSON.stringify(list));
  }

  listKnownCentrals(): Array<{ host: string; port: number; lastSeenAt: string }> {
    const raw = this.loadSetting('knownCentrals') ?? '[]';
    try {
      return JSON.parse(raw) as Array<{ host: string; port: number; lastSeenAt: string }>;
    } catch {
      return [];
    }
  }

  getMonthlySummaryRows(): Array<{ month: string; employeeId: string; employeeName: string; presentCount: number; lateCount: number; absentCount: number; equivalentAbsence: number; totalAbsents: number; workDays: number; updatedAt: string }> {
    const rows = this.db.prepare(`
      SELECT substr(attendanceDate, 1, 7) AS month,
             employeeId,
             employeeName,
             SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) AS presentCount,
             SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) AS lateCount,
             SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) AS absentCount,
             MAX(updatedAt) AS updatedAt
      FROM AttendanceCache
      GROUP BY substr(attendanceDate, 1, 7), employeeId, employeeName
      ORDER BY month DESC, employeeName ASC
    `).all() as Array<{ month: string; employeeId: string; employeeName: string; presentCount: number; lateCount: number; absentCount: number; updatedAt: string }>;
    return rows.map((row) => {
      const equivalentAbsence = calculateEquivalentAbsence(Number(row.lateCount ?? 0));
      return {
        ...row,
        equivalentAbsence,
        totalAbsents: Number(row.absentCount ?? 0) + equivalentAbsence,
        workDays: this.getWorkDaysForMonth(String(row.month))
      };
    });
  }

  private getWorkDaysForMonth(month: string): number {
    const [yearText, monthText] = month.split('-');
    const year = Number(yearText);
    const monthIndex = Number(monthText) - 1;
    if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) {
      return 0;
    }
    const firstDay = new Date(Date.UTC(year, monthIndex, 1));
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
    let count = 0;
    for (let day = firstDay.getUTCDate(); day <= lastDay.getUTCDate(); day += 1) {
      const current = new Date(Date.UTC(year, monthIndex, day));
      if (current.getUTCDay() !== 0) {
        count += 1;
      }
    }
    return count;
  }
}