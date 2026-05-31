import cors from 'cors';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { google } from 'googleapis';
import jwt from 'jsonwebtoken';
import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import dgram from 'node:dgram';
import os from 'node:os';
import winston from 'winston';
import { getDatabasePath, openDatabase, runSchema } from './database';
import { ensureSecretFile } from '../shared/crypto';
import { APP_NAME, ATTENDANCE_REMINDER_INTERVAL_MS, CENTRAL_ACTIVATION_CODE, INTERNET_TIME_URL, LATE_THRESHOLD, PKT_TIME_ZONE, SHIFT_END, SHIFT_START, SYNC_INTERVAL_MS, TRUSTED_DRIFT_LIMIT_MINUTES } from '../shared/constants';
import { calculateEquivalentAbsence, determineAttendanceStatus, formatPktTimestamp, getShiftWindow, isWithinAttendanceWindow, pktDateString, pktDateTimeString, pktTimeString } from '../shared/time';
import type { AppStatus, AttendanceRecord, EmployeeRecord, LoginRequest, MachineInfo, SessionState, SystemHealthSnapshot, SyncQueuePayload } from '../shared/types';
import { loginRequestSchema, manualCorrectionSchema } from '../shared/validation';
import { NexStackStore } from './store';

interface TrustedTimeResult {
  date: Date;
  source: 'internet' | 'local';
  driftMinutes: number;
  internetAvailable: boolean;
}

interface TimeApiPayload {
  datetime?: string;
  dateTime?: string;
  currentLocalTime?: string;
}

interface CentralBootstrapPayload {
  centralHost: string;
  centralPort: number;
  syncToken: string;
  employees: Array<{ employeeId: string; employeeName: string; role: string; active: number; sourceVersion?: string | null }>;
}

interface ClientSetupRequest {
  centralHost?: string;
  centralPort?: number;
}

interface GoogleEmployeeRow {
  employeeId: string;
  employeeName: string;
  role: string;
  active: number;
  sourceVersion: string;
}

function resolveJsonOrFileContent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  if (fs.existsSync(trimmed)) {
    return fs.readFileSync(trimmed, 'utf8').trim();
  }
  return trimmed;
}

function parseActiveCell(value: unknown): number {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 1;
  }
  if (['true', '1', 'yes', 'y', 'active'].includes(normalized)) {
    return 1;
  }
  if (['false', '0', 'no', 'n', 'inactive'].includes(normalized)) {
    return 0;
  }
  return 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const BUNDLED_SPREADSHEET_ID = '1kz0NfIz3909f-7Wp0EWoZZnocqPg3KvbfetlOfSPI8w';

export class NexStackBackend {
  private db: Awaited<ReturnType<typeof openDatabase>> | null = null;
  private store!: NexStackStore;
  private readonly secret: string;
  private readonly logger: winston.Logger;
  private server: Server | null = null;
  private port = 0;
  private tray: Tray | null = null;
  private reminderWindow: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;
  private watchdogActive = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private reminderTimer: NodeJS.Timeout | null = null;
  private timeTimer: NodeJS.Timeout | null = null;
  private trustedTime: TrustedTimeResult = { date: new Date(), source: 'local', driftMinutes: 0, internetAvailable: false };
  private udpSocket: dgram.Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private pushToCentralTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.secret = ensureSecretFile(path.join(app.getPath('userData'), 'secret.key'));
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      transports: [new winston.transports.File({ filename: path.join(app.getPath('userData'), 'nexstacksolutions.log') })]
    });
  }

  async start(mainWindow: BrowserWindow): Promise<number> {
    this.mainWindow = mainWindow;
    this.db = await openDatabase();
    runSchema(this.db, fs.readFileSync(path.join(app.getAppPath(), 'database', 'schema.sql'), 'utf8'));
    this.store = new NexStackStore(this.db, this.secret);
    await this.ensureDefaultData();
    // Load optional client-known central override (created by installer or prepare-client script)
    try {
      const cfgPath = path.join(app.getPath('userData'), 'client_known_central.json');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const obj = JSON.parse(raw) as { centralHost?: string; centralPort?: number } | null;
        if (obj && obj.centralHost && obj.centralPort) {
          this.store.addKnownCentral(String(obj.centralHost), Number(obj.centralPort));
          this.logger.info('client_known_central_loaded', { host: obj.centralHost, port: obj.centralPort });
        }
      }
    } catch (e) {
      this.logger.warn('load_client_known_central_failed', { error: e instanceof Error ? e.message : String(e) });
    }
    await this.startServer();
    // Begin LAN discovery listener and periodic push to discovered centrals
    this.initializeUdpListener();
    void this.refreshRosterFromKnownCentrals();
    this.pushToCentralTimer = setInterval(() => void this.pushPendingToCentrals(), 30 * 1000);
    this.registerWatchdog();
    this.setupTray();
    this.beginSchedulers();
    this.registerAutoStart();
    return this.port;
  }

  async checkForUpdatesAtStartup(): Promise<void> {
    if (!app.isPackaged) {
      return;
    }
    autoUpdater.logger = this.logger;
    await autoUpdater.checkForUpdatesAndNotify();
  }

  getHealth(): SystemHealthSnapshot {
    return this.store.getHealthSnapshot();
  }

  getSession(): EmployeeRecord | null {
    const session = this.store.getLatestSession();
    if (!session) {
      return null;
    }
    const employee = this.store.getEmployee(session.employeeId);
    if (!employee) {
      return null;
    }
    return employee;
  }

  async bootstrap(): Promise<{ session: EmployeeRecord | null; status: AppStatus; health: SystemHealthSnapshot }> {
    const session = this.getSession();
    const status = await this.getStatus(session?.employeeId ?? null);
    return { session, status, health: this.getHealth() };
  }

  async login(payload: unknown): Promise<{ session: EmployeeRecord; status: AppStatus }> {
    const request = loginRequestSchema.parse(payload) as LoginRequest;
    let employee = this.store.getEmployee(request.employeeId);
    if (!employee || !employee.active) {
      const googleEmployee = await this.findEmployeeInGoogle(request.employeeId);
      if (googleEmployee) {
        this.store.seedEmployees([googleEmployee]);
        employee = this.store.getEmployee(request.employeeId);
      }
    }
    if (!employee || !employee.active) {
      await this.bootstrapGoogleCache();
      await this.refreshRosterFromKnownCentrals();
      employee = this.store.getEmployee(request.employeeId);
    }
    if (!employee || !employee.active) {
      throw new Error('Employee ID not found or inactive');
    }
    const trustedTime = await this.getTrustedTime();
    const session: SessionState = {
      employeeId: employee.employeeId,
      role: employee.role,
      token: jwt.sign({ employeeId: employee.employeeId, role: employee.role, machineFingerprint: request.machineInfo.deviceFingerprint }, this.secret, { expiresIn: '14d' }),
      machineFingerprint: request.machineInfo.deviceFingerprint,
      expiresAt: new Date(trustedTime.date.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
    };
    this.store.upsertSession(session);
    this.verifyDevice(employee, request.machineInfo);
    const status = await this.getStatus(employee.employeeId);
    this.logger.info('employee_login', { employeeId: employee.employeeId, machineFingerprint: request.machineInfo.deviceFingerprint });
    return { session: employee, status };
  }

  async logout(): Promise<void> {
    this.store.clearSession();
    this.logger.info('session_logout');
  }

  async setupEmployeeClient(payload: unknown): Promise<{ ok: boolean; message: string; centralHost: string; centralPort: number; employeeCount: number }> {
    const request = (payload ?? {}) as ClientSetupRequest;
    const requestedHost = String(request.centralHost ?? '').trim();
    const requestedPort = Number(request.centralPort ?? 0);
    if (requestedHost) {
      const defaultPort = requestedHost.startsWith('https://') ? 443 : 80;
      const effectivePort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : defaultPort;
      this.store.addKnownCentral(requestedHost, effectivePort);
    }

    await this.refreshRosterFromKnownCentrals();
    const known = this.store.listKnownCentrals();
    const selected = requestedHost
      ? known.find((item) => item.host === requestedHost) ?? known[0] ?? null
      : known[0] ?? null;
    if (!selected) {
      throw new Error('No central host discovered. Keep central running on same LAN or enter a public central endpoint (for example: https://central.example.com).');
    }

    const cfgPath = path.join(app.getPath('userData'), 'client_known_central.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ centralHost: selected.host, centralPort: selected.port }, null, 2), 'utf8');
    this.store.saveSetting('centralHost', selected.host);
    this.store.saveSetting('centralPort', String(selected.port));

    const employeeCountRow = this.db!.prepare('SELECT COUNT(*) AS total FROM EmployeeCache').get() as { total?: number };
    const employeeCount = Number(employeeCountRow?.total ?? 0);
    return {
      ok: true,
      message: `Client configured for ${selected.host}:${selected.port}`,
      centralHost: selected.host,
      centralPort: selected.port,
      employeeCount
    };
  }

  async checkIn(machineInfo: MachineInfo): Promise<{ ok: boolean; message: string; status: AppStatus; record?: AttendanceRecord }> {
    const session = this.getSession();
    if (!session) {
      throw new Error('No active session');
    }
    const trustedTime = await this.getTrustedTime(true);
    const currentShift = getShiftWindow(trustedTime.date);
    if (!isWithinAttendanceWindow(trustedTime.date)) {
      throw new Error('Check-in is only allowed during the scheduled shift window');
    }
    const existing = this.store.getAttendance(session.employeeId, currentShift.shiftDate);
    if (existing) {
      this.hideReminderWindow();
      return { ok: false, message: 'Already checked in for this shift', status: await this.getStatus(session.employeeId), record: existing };
    }
    const attendanceDate = currentShift.shiftDate;
    const checkedInAt = pktDateTimeString(trustedTime.date);
    const statusValue = determineAttendanceStatus(trustedTime.date);
    const record: AttendanceRecord = {
      employeeId: session.employeeId,
      employeeName: session.employeeName,
      attendanceDate,
      checkedInAt,
      status: statusValue,
      equivalentAbsence: statusValue === 'Late' ? this.store.getEquivalentAbsence(session.employeeId) : 0,
      source: 'local'
    };
    this.store.upsertAttendance(record);
    this.store.queueAttendance({
      employeeId: record.employeeId,
      employeeName: record.employeeName,
      attendanceDate: record.attendanceDate,
      checkedInAt: record.checkedInAt ?? checkedInAt,
      status: record.status,
      source: 'local'
    });
    this.store.recordAudit({
      timestamp: formatPktTimestamp(trustedTime.date),
      adminId: session.role === 'Admin' ? session.employeeId : 'SYSTEM',
      employeeId: session.employeeId,
      action: 'ATTENDANCE_CHECK_IN',
      oldValue: null,
      newValue: JSON.stringify(record),
      reason: 'Employee self check-in',
      machineInfo
    });
    await this.syncIfOnline();
    this.hideReminderWindow();
    const updatedStatus = await this.getStatus(session.employeeId);
    return { ok: true, message: statusValue === 'Late' ? 'Late check-in recorded' : 'Check-in recorded', status: updatedStatus, record };
  }

  async manualCorrection(payload: unknown): Promise<{ ok: boolean; message: string }> {
    const request = manualCorrectionSchema.parse(payload);
    const employee = this.store.getEmployee(request.employeeId);
    if (!employee) {
      throw new Error('Employee not found');
    }
    const current = this.store.getAttendance(request.employeeId, request.attendanceDate);
    this.store.upsertAttendance({
      employeeId: request.employeeId,
      employeeName: employee.employeeName,
      attendanceDate: request.attendanceDate,
      checkedInAt: current?.checkedInAt ?? null,
      status: request.newValue as AttendanceRecord['status'],
      equivalentAbsence: request.newValue === 'Late' ? this.store.getEquivalentAbsence(request.employeeId) : 0,
      source: 'local'
    });
    this.store.recordAudit({
      timestamp: pktDateTimeString(await this.getTrustedTimeDate()),
      adminId: request.adminId,
      employeeId: request.employeeId,
      action: 'MANUAL_CORRECTION',
      oldValue: request.oldValue,
      newValue: request.newValue,
      reason: request.reason,
      machineInfo: request.machineInfo
    });
    await this.syncIfOnline();
    return { ok: true, message: 'Manual correction saved and queued for sync' };
  }

  async getDashboard(employeeId: string | null): Promise<{ status: AppStatus; attendance: AttendanceRecord[]; reports: unknown }> {
    const status = await this.getStatus(employeeId);
    const attendance = employeeId ? [this.store.getAttendance(employeeId, status.attendanceDate)].filter(Boolean).map((item) => item as AttendanceRecord) : this.store.listAttendance(100);
    const reports = employeeId ? { equivalentAbsence: this.store.getEquivalentAbsence(employeeId), lateCount: this.store.getLateCount(employeeId) } : this.buildAdminReport();
    return { status, attendance, reports };
  }

  async exportCsv(kind: string): Promise<{ ok: boolean; path: string }> {
    const exportsDir = path.join(app.getPath('documents'), 'NexStackSolutions-Exports');
    fs.mkdirSync(exportsDir, { recursive: true });
    const filePath = path.join(exportsDir, `${kind}-${Date.now()}.csv`);
    let rows: Array<Record<string, string | number | null>> = [];
    if (kind === 'monthly-attendance' || kind === 'attendance') {
      rows = this.store.listAttendance(500).map((row) => ({ ...row }));
    } else if (kind === 'equivalent-absence') {
      rows = this.store.listAttendance(500).map((row) => ({ employeeId: row.employeeId, employeeName: row.employeeName, equivalentAbsence: row.equivalentAbsence }));
    } else if (kind === 'late-reports') {
      rows = this.store.listAttendance(500).filter((row) => row.status === 'Late').map((row) => ({ employeeId: row.employeeId, employeeName: row.employeeName, checkedInAt: row.checkedInAt }));
    }
    const headers = rows.length > 0 ? Object.keys(rows[0]) : ['message'];
    const lines = [headers.join(',')].concat(rows.map((row) => headers.map((header) => JSON.stringify(row[header] ?? '')).join(',')));
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return { ok: true, path: filePath };
  }

  async syncNow(): Promise<{ synced: number; failed: number }> {
    const queue = this.store.listPendingQueue();
    let synced = 0;
    let failed = 0;
    for (const item of queue) {
      try {
        const payload = this.store.decryptQueuePayload(item.payloadEncrypted) as unknown as SyncQueuePayload;
        await this.pushAttendanceToGoogle(payload);
        this.store.markQueueSynced(item.id, 'Uploaded to Google Sheets');
        synced += 1;
      } catch (error) {
        failed += 1;
        this.store.markQueueFailed(item.id, error instanceof Error ? error.message : 'Unknown sync failure');
      }
    }
    this.store.saveSetting('lastSyncAt', new Date().toISOString());
    return { synced, failed };
  }

  private async getStatus(employeeId: string | null): Promise<AppStatus> {
    const trustedTime = await this.getTrustedTime();
    const shift = getShiftWindow(trustedTime.date);
    const attendance = employeeId ? this.store.getAttendance(employeeId, shift.shiftDate) : null;
    return {
      currentTimePkt: pktTimeString(trustedTime.date),
      shiftStartPkt: SHIFT_START,
      shiftEndPkt: SHIFT_END,
      lateThresholdPkt: LATE_THRESHOLD,
      attendanceDate: shift.shiftDate,
      isWithinAttendanceWindow: isWithinAttendanceWindow(trustedTime.date),
      hasCheckedInToday: Boolean(attendance),
      statusText: attendance ? `Already checked in for this shift (${attendance.status})` : (isWithinAttendanceWindow(trustedTime.date) ? 'Please Check In' : 'Waiting for shift window')
    };
  }

  private async getTrustedTimeDate(): Promise<Date> {
    return (await this.getTrustedTime()).date;
  }

  private async tryGetInternetTime(): Promise<Date | null> {
    const urls = [
      INTERNET_TIME_URL,
      'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Karachi'
    ];
    for (const url of urls) {
      try {
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
          continue;
        }
        const payload = await response.json() as TimeApiPayload;
        const value = payload.datetime ?? payload.dateTime ?? payload.currentLocalTime;
        if (!value) {
          continue;
        }
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
          return date;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private async isInternetReachable(): Promise<boolean> {
    try {
      const response = await fetch('https://www.google.com/generate_204', { method: 'GET' });
      if (response.ok) {
        return true;
      }
    } catch {
      // fallback to DNS probe below
    }
    try {
      await dns.lookup('www.google.com');
      return true;
    } catch {
      return false;
    }
  }

  private async getTrustedTime(requireInternet = false): Promise<TrustedTimeResult> {
    const internetDate = await this.tryGetInternetTime();
    if (internetDate) {
      const localDate = new Date();
      const driftMinutes = Math.abs(internetDate.getTime() - localDate.getTime()) / 60000;
      this.store.setSystemHealth('internetAvailable', 'true', 'info');
      this.store.setSystemHealth('trustedTimeSource', 'internet', driftMinutes > TRUSTED_DRIFT_LIMIT_MINUTES ? 'warning' : 'info');
      this.store.setSystemHealth('timeDriftMinutes', driftMinutes.toFixed(2), driftMinutes > TRUSTED_DRIFT_LIMIT_MINUTES ? 'warning' : 'info');
      this.trustedTime = { date: internetDate, source: 'internet', driftMinutes, internetAvailable: true };
      return this.trustedTime;
    }

    const online = await this.isInternetReachable();
    const localDate = new Date();
    this.store.setSystemHealth('internetAvailable', online ? 'true' : 'false', online ? 'info' : 'warning');
    this.store.setSystemHealth('trustedTimeSource', 'local', 'warning');
    if (requireInternet) {
      throw new Error('Internet time is required for check-in. Please connect to the internet and try again.');
    }
    this.trustedTime = { date: localDate, source: 'local', driftMinutes: 0, internetAvailable: online };
    return this.trustedTime;
  }

  private verifyDevice(employee: EmployeeRecord, machineInfo: MachineInfo): void {
    this.store.recordDevice(machineInfo, employee.employeeId, null, false);
  }

  private async ensureDefaultData(): Promise<void> {
    const employeeCount = this.db!.prepare('SELECT COUNT(*) AS total FROM EmployeeCache').get() as { total: number };
    if (employeeCount.total === 0) {
      this.store.seedEmployees([
        { employeeId: 'EMP001', employeeName: 'Hamdan', role: 'Employee', active: 1, sourceVersion: 'bootstrap' },
        { employeeId: 'EMP023', employeeName: 'Ahmed', role: 'Employee', active: 1, sourceVersion: 'bootstrap' },
        { employeeId: 'ADMIN001', employeeName: 'Admin', role: 'Admin', active: 1, sourceVersion: 'bootstrap' }
      ]);
    }
    this.store.saveSetting('watchdogActive', 'true');
    this.store.saveSetting('lastSyncAt', this.store.loadSetting('lastSyncAt') ?? '');
    await this.bootstrapGoogleCache();
  }

  private async refreshRosterFromKnownCentrals(): Promise<boolean> {
    const centrals = this.store.listKnownCentrals();
    let refreshed = false;
    for (const central of centrals) {
      try {
        const bootstrap = await this.fetchCentralBootstrap(central.host, central.port);
        if (!bootstrap) {
          continue;
        }
        if (bootstrap.employees.length > 0) {
          this.store.seedEmployees(bootstrap.employees);
        }
        this.store.saveSetting('centralHost', bootstrap.centralHost);
        this.store.saveSetting('centralPort', String(bootstrap.centralPort));
        this.store.saveSetting('syncToken', bootstrap.syncToken);
        this.store.addKnownCentral(bootstrap.centralHost, bootstrap.centralPort);
        refreshed = true;
      } catch (error) {
        this.logger.warn('central_roster_refresh_failed', { host: central.host, port: central.port, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return refreshed;
  }

  private buildCentralBaseUrl(host: string, port: number): string {
    const normalizedHost = String(host ?? '').trim().replace(/\/+$/, '');
    if (!normalizedHost) {
      return '';
    }
    if (/^https?:\/\//i.test(normalizedHost)) {
      const parsed = new URL(normalizedHost);
      if (parsed.port) {
        return `${parsed.protocol}//${parsed.host}`;
      }
      const isDefaultPort = (parsed.protocol === 'https:' && port === 443) || (parsed.protocol === 'http:' && port === 80);
      return isDefaultPort ? `${parsed.protocol}//${parsed.hostname}` : `${parsed.protocol}//${parsed.hostname}:${port}`;
    }
    return `http://${normalizedHost}:${port}`;
  }

  private async fetchCentralBootstrap(host: string, port: number): Promise<CentralBootstrapPayload | null> {
    const baseUrl = this.buildCentralBaseUrl(host, port);
    if (!baseUrl) {
      return null;
    }
    const url = `${baseUrl}/sync/bootstrap`;
    try {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json() as CentralBootstrapPayload;
      if (!payload || !payload.centralHost || !payload.centralPort || !payload.syncToken || !Array.isArray(payload.employees)) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private async bootstrapGoogleCache(): Promise<void> {
    const rows = await this.loadEmployeesFromGoogle();
    if (rows.length > 0) {
      this.store.seedEmployees(rows);
    }
  }

  private async loadEmployeesFromGoogle(): Promise<GoogleEmployeeRow[]> {
    const client = this.getGoogleSheetsClient();
    if (!client) return [];
    const { sheets, sheetId } = client;
    try {
      await this.ensureGoogleWorkbookStructure(sheets, sheetId);
      let employeeValues: unknown[][] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Employees!A2:D' });
          employeeValues = (response.data.values ?? []) as unknown[][];
          break;
        } catch (error) {
          if (attempt === 2) {
            throw error;
          }
          await sleep(300 * (attempt + 1));
        }
      }
      const rows = employeeValues.filter((r) => {
        const id = String(r[0] ?? '').trim();
        const name = String(r[1] ?? '').trim();
        return id.length > 0 && name.length > 0;
      }).map((row: unknown[]) => ({
        employeeId: String(row[0] ?? '').trim(),
        employeeName: String(row[1] ?? '').trim(),
        role: String(row[2] ?? 'Employee'),
        active: parseActiveCell(row[3]),
        sourceVersion: 'google'
      })) as GoogleEmployeeRow[];
      return rows;
    } catch (error) {
      this.logger.warn('google_cache_bootstrap_failed', { error: error instanceof Error ? error.message : 'Unknown error' });
      return [];
    }
  }

  private async findEmployeeInGoogle(employeeId: string): Promise<GoogleEmployeeRow | null> {
    const rows = await this.loadEmployeesFromGoogle();
    const normalized = employeeId.trim().toLowerCase();
    return rows.find((row) => row.employeeId.trim().toLowerCase() === normalized) ?? null;
  }

  private getGoogleSheetsClient(): { sheets: ReturnType<typeof google.sheets>; sheetId: string } | null {
    let sheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    let serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (!serviceAccountJson) {
      const serviceAccountFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE ?? '';
      if (serviceAccountFile) {
        try {
          if (fs.existsSync(serviceAccountFile)) {
            serviceAccountJson = fs.readFileSync(serviceAccountFile, 'utf8').trim();
          }
        } catch {
          // fall through to other sources
        }
      }
    } else {
      try {
        serviceAccountJson = resolveJsonOrFileContent(serviceAccountJson);
      } catch {
        // fall through to other sources
      }
    }

    if (!serviceAccountJson) {
      const bundledCandidates = [
        path.join(app.getPath('userData'), 'service-account.json'),
        path.join(app.getPath('userData'), 'google-service-account.json'),
        path.join(app.getPath('userData'), 'attendance-google-service-account.json'),
        path.join(process.cwd(), 'google-service-account.json')
      ];
      for (const candidate of bundledCandidates) {
        try {
          if (fs.existsSync(candidate)) {
            serviceAccountJson = fs.readFileSync(candidate, 'utf8').trim();
            break;
          }
        } catch {
          // try next path
        }
      }
    }

    if (serviceAccountJson) {
      try {
        serviceAccountJson = resolveJsonOrFileContent(serviceAccountJson);
      } catch {
        // keep original value for parse attempt below
      }
    }

    if (!sheetId) {
      sheetId = BUNDLED_SPREADSHEET_ID;
    }

    if (!sheetId || !serviceAccountJson) {
      return null;
    }
    const credentials = JSON.parse(serviceAccountJson) as Record<string, string>;
    const auth = new google.auth.JWT(credentials.client_email, undefined, credentials.private_key, ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth });
    return { sheets, sheetId };
  }

  private async ensureGoogleWorkbookStructure(sheets: ReturnType<typeof google.sheets>, sheetId: string): Promise<void> {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existing = (meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[];
    const required = ['Employees', 'Attendance', 'Monthly', 'AuditLogs', 'SystemConfig'];
    const requests: Array<Record<string, unknown>> = [];
    for (const name of required) {
      if (!existing.includes(name)) {
        requests.push({ addSheet: { properties: { title: name } } });
      }
    }
    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests } });
    }

    const employeeHeader = ['EmployeeID', 'EmployeeName', 'Role', 'Active'];
    const employeeHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Employees!A1:D1' }).catch(() => ({ data: { values: [] } }));
    const currentEmployeeHeader = (employeeHeaderResp.data.values?.[0] ?? []).map(String);
    if (currentEmployeeHeader.length === 0 || currentEmployeeHeader.join('|') !== employeeHeader.join('|')) {
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Employees!A1:D1', valueInputOption: 'RAW', requestBody: { values: [employeeHeader] } });
    }

    const attendanceHeader = ['Date'];
    const attendanceHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Attendance!A1:ZZ1' }).catch(() => ({ data: { values: [] } }));
    const currentAttendanceHeader = (attendanceHeaderResp.data.values?.[0] ?? []).map(String);
    if (currentAttendanceHeader.length === 0 || currentAttendanceHeader[0] !== 'Date') {
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Attendance!A1:ZZ1', valueInputOption: 'RAW', requestBody: { values: [attendanceHeader] } });
    }

    const monthlyHeader = ['Month', 'EmployeeID', 'EmployeeName', 'Present', 'Late', 'Absent', 'EquivalentAbsence', 'TotalAbsents', 'WorkDays', 'UpdatedAt'];
    const monthlyHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Monthly!A1:J1' }).catch(() => ({ data: { values: [] } }));
    const currentMonthlyHeader = (monthlyHeaderResp.data.values?.[0] ?? []).map(String);
    if (currentMonthlyHeader.length === 0 || currentMonthlyHeader.join('|') !== monthlyHeader.join('|')) {
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Monthly!A1:J1', valueInputOption: 'RAW', requestBody: { values: [monthlyHeader] } });
    }

    const auditHeader = ['Timestamp', 'AdminID', 'EmployeeID', 'Action', 'OldValue', 'NewValue', 'Reason'];
    const auditHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'AuditLogs!A1:G1' }).catch(() => ({ data: { values: [] } }));
    const currentAuditHeader = (auditHeaderResp.data.values?.[0] ?? []).map(String);
    if (currentAuditHeader.length === 0 || currentAuditHeader.join('|') !== auditHeader.join('|')) {
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'AuditLogs!A1:G1', valueInputOption: 'RAW', requestBody: { values: [auditHeader] } });
    }

    const systemHeader = ['Key', 'Value'];
    const systemHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'SystemConfig!A1:B1' }).catch(() => ({ data: { values: [] } }));
    const currentSystemHeader = (systemHeaderResp.data.values?.[0] ?? []).map(String);
    if (currentSystemHeader.length === 0 || currentSystemHeader.join('|') !== systemHeader.join('|')) {
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'SystemConfig!A1:B1', valueInputOption: 'RAW', requestBody: { values: [systemHeader] } });
    }

    this.store.saveSetting('sheetsInitialized', 'true');
  }

  private async pushAttendanceToGoogle(payload: SyncQueuePayload): Promise<void> {
    const client = this.getGoogleSheetsClient();
    if (!client) {
      throw new Error('Google Sheets configuration is not available');
    }
    const { sheets, sheetId } = client;
    await this.ensureGoogleWorkbookStructure(sheets, sheetId);

    const headerResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Attendance!A1:ZZ1' });
    const headers = (headerResponse.data.values?.[0] ?? []).map(String);
    const normalizedHeaders = headers.length > 0 ? headers : ['Date'];
    const employeeHeader = payload.employeeName;
    const statusHeader = employeeHeader;
    const timeHeader = `${employeeHeader} Time`;

    let finalHeaders = [...normalizedHeaders];
    if (!finalHeaders.includes(statusHeader)) {
      finalHeaders.push(statusHeader);
    }
    if (!finalHeaders.includes(timeHeader)) {
      finalHeaders.push(timeHeader);
    }
    if (finalHeaders.join('|') !== normalizedHeaders.join('|')) {
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Attendance!A1:ZZ1', valueInputOption: 'RAW', requestBody: { values: [finalHeaders] } });
    }

    const dateResponse = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Attendance!A2:A5000' });
    const dates = (dateResponse.data.values ?? []).map((row) => String(row[0] ?? ''));
    const targetRowIndex = dates.findIndex((rowDate) => rowDate === payload.attendanceDate);
    const effectiveStatus = payload.status === 'Absent' ? 'Absent' : payload.status === 'Late' ? 'Late' : 'Present';
    const checkInTime = payload.checkedInAt ? String(payload.checkedInAt).split(' ')[1] ?? String(payload.checkedInAt) : '';
    const statusColumnIndex = finalHeaders.findIndex((header) => header === statusHeader);
    const timeColumnIndex = finalHeaders.findIndex((header) => header === timeHeader);

    const buildRow = (existing: string[]) => {
      const row = existing.concat(new Array(Math.max(0, finalHeaders.length - existing.length)).fill(''));
      row[0] = payload.attendanceDate;
      row[statusColumnIndex] = effectiveStatus;
      row[timeColumnIndex] = effectiveStatus === 'Absent' ? '' : checkInTime;
      return row;
    };

    if (targetRowIndex === -1) {
      const row = new Array(finalHeaders.length).fill('');
      row[0] = payload.attendanceDate;
      row[statusColumnIndex] = effectiveStatus;
      row[timeColumnIndex] = effectiveStatus === 'Absent' ? '' : checkInTime;
      await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: 'Attendance!A:ZZ', valueInputOption: 'RAW', requestBody: { values: [row] } });
    } else {
      const existingRows = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `Attendance!A${targetRowIndex + 2}:ZZ${targetRowIndex + 2}` });
      const row = buildRow((existingRows.data.values?.[0] ?? []).map(String));
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `Attendance!A${targetRowIndex + 2}:ZZ${targetRowIndex + 2}`, valueInputOption: 'RAW', requestBody: { values: [row] } });
    }

    await this.updateMonthlyReportSheet(sheets, sheetId);
    await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: 'AuditLogs!A:G', valueInputOption: 'RAW', requestBody: { values: [[new Date().toISOString(), 'SYSTEM', payload.employeeId, 'SYNC_ATTENDANCE', '', JSON.stringify(payload), 'Attendance uploaded']] } });
  }

  private async updateMonthlyReportSheet(sheets: ReturnType<typeof google.sheets>, sheetId: string): Promise<void> {
    const monthlyRows = this.store.getMonthlySummaryRows();
    const header = ['Month', 'EmployeeID', 'EmployeeName', 'Present', 'Late', 'Absent', 'EquivalentAbsence', 'TotalAbsents', 'WorkDays', 'UpdatedAt'];
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Monthly!A1:J1', valueInputOption: 'RAW', requestBody: { values: [header] } });
    if (monthlyRows.length === 0) {
      return;
    }
    const values = monthlyRows.map((row) => [row.month, row.employeeId, row.employeeName, row.presentCount, row.lateCount, row.absentCount, row.equivalentAbsence, row.totalAbsents, row.workDays, row.updatedAt]);
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `Monthly!A2:J${values.length + 1}`, valueInputOption: 'RAW', requestBody: { values } });
  }

  private async claimCentralMachine(code: string): Promise<{ ok: boolean; message: string; centralHost: string }> {
    const normalized = String(code ?? '').trim();
    if (normalized !== CENTRAL_ACTIVATION_CODE) {
      throw new Error('Invalid central activation code');
    }

    const alreadyCentral = this.store.loadSetting('isCentral') === 'true';
    const localHost = this.getLocalIpv4() ?? os.hostname();
    const centralHost = this.store.loadSetting('centralHost') ?? localHost;
    if (alreadyCentral) {
      this.startAnnouncer();
      return { ok: true, message: 'This machine is already central', centralHost };
    }

    const client = this.getGoogleSheetsClient();
    if (client) {
      const { sheets, sheetId } = client;
      await this.ensureGoogleWorkbookStructure(sheets, sheetId);
      const existing = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'SystemConfig!A2:B50' }).catch(() => ({ data: { values: [] } }));
      const rows = (existing.data.values ?? []).map((row) => [String(row[0] ?? ''), String(row[1] ?? '')]);
      const existingCentral = rows.find(([key]) => key === 'CentralHost')?.[1] ?? '';
      if (existingCentral && existingCentral !== localHost) {
        throw new Error(`Another central is already registered: ${existingCentral}`);
      }
      const updatedRows = [
        ['CentralHost', localHost],
        ['CentralClaimedAt', new Date().toISOString()],
        ['CentralCode', CENTRAL_ACTIVATION_CODE],
        ['CentralPort', String(this.port)]
      ];
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'SystemConfig!A2:B5', valueInputOption: 'RAW', requestBody: { values: updatedRows } });
    }

    const syncToken = this.store.loadSetting('syncToken') ?? crypto.randomBytes(32).toString('hex');
    this.store.saveSetting('isCentral', 'true');
    this.store.saveSetting('centralHost', localHost);
    this.store.saveSetting('centralPort', String(this.port));
    this.store.saveSetting('centralClaimedAt', new Date().toISOString());
    this.store.saveSetting('syncToken', syncToken);
    this.startAnnouncer();
    return { ok: true, message: 'Central mode enabled', centralHost: localHost };
  }

  private async syncIfOnline(): Promise<void> {
    if (!this.trustedTime.internetAvailable) {
      return;
    }
    await this.syncNow();
  }

  private buildAdminReport(): Record<string, unknown> {
    const attendance = this.store.listAttendance(500);
    const lateRows = attendance.filter((row) => row.status === 'Late');
    const equivalentAbsence = new Map<string, number>();
    for (const row of attendance) {
      equivalentAbsence.set(row.employeeId, this.store.getEquivalentAbsence(row.employeeId));
    }
    return {
      attendanceCount: attendance.length,
      lateCount: lateRows.length,
      equivalentAbsence: Object.fromEntries(equivalentAbsence.entries()),
      deviceViolations: this.db!.prepare('SELECT * FROM DeviceInfo WHERE isUnexpected = 1 ORDER BY lastSeenAt DESC LIMIT 100').all()
    };
  }

  private async startServer(): Promise<void> {
    const appServer = express();
    appServer.use(cors());
    appServer.use(express.json({ limit: '1mb' }));
    appServer.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      next();
    });

    appServer.get('/health', (_req, res) => res.json({ ok: true, health: this.getHealth(), port: this.port, dbPath: getDatabasePath() }));
    appServer.get('/auth/bootstrap', async (_req, res) => res.json(await this.bootstrap()));
    appServer.post('/auth/login', async (req, res) => {
      try {
        res.json(await this.login(req.body));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Login failed' });
      }
    });
    appServer.post('/auth/logout', async (_req, res) => {
      await this.logout();
      res.json({ ok: true });
    });
    appServer.get('/attendance/dashboard', async (req, res) => res.json(await this.getDashboard(typeof req.query.employeeId === 'string' ? req.query.employeeId : null)));
    appServer.post('/attendance/check-in', async (req, res) => {
      try {
        const result = await this.checkIn(req.body.machineInfo as MachineInfo);
        res.json(result);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Check-in failed' });
      }
    });
    appServer.post('/admin/correction', async (req, res) => {
      try {
        res.json(await this.manualCorrection(req.body));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Correction failed' });
      }
    });
    appServer.get('/export/:kind', async (req, res) => {
      try {
        res.json(await this.exportCsv(req.params.kind));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Export failed' });
      }
    });
    appServer.post('/sync/run', async (_req, res) => res.json(await this.syncNow()));
    // Return list of discovered central endpoints
    appServer.get('/sync/centrals', (_req, res) => {
      res.json({ centrals: this.store.listKnownCentrals() });
    });

    appServer.post('/sync/setup-client', async (req, res) => {
      try {
        res.json(await this.setupEmployeeClient(req.body));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Client setup failed' });
      }
    });

    appServer.get('/sync/bootstrap', (_req, res) => {
      const centralHost = this.store.loadSetting('centralHost') ?? this.getLocalIpv4() ?? os.hostname();
      const centralPort = Number(this.store.loadSetting('centralPort') ?? this.port);
      const syncToken = this.store.loadSetting('syncToken') ?? '';
      const employees = this.db!.prepare('SELECT employeeId, employeeName, role, active, sourceVersion FROM EmployeeCache ORDER BY employeeName ASC').all() as CentralBootstrapPayload['employees'];
      res.json({ centralHost, centralPort, syncToken, employees });
    });

    // Receive pushed attendance from other nodes (central ingestion)
    appServer.post('/sync/receive', async (req, res) => {
      try {
        const authToken = String((req.headers['x-nexstack-sync-token'] ?? ''));
        const authSecret = String((req.headers['x-nexstack-secret'] ?? ''));
        const syncToken = this.store.loadSetting('syncToken') ?? '';
        if (!authToken || (syncToken && authToken !== syncToken && authSecret !== this.secret)) {
          res.status(403).json({ error: 'Unauthorized' });
          return;
        }
        const payloads: Array<SyncQueuePayload> = Array.isArray(req.body) ? req.body : [req.body];
        let processed = 0;
        for (const payload of payloads) {
          try {
            // Persist to local attendance cache and optionally push to Google if available
            this.store.upsertAttendance({
              employeeId: payload.employeeId,
              employeeName: payload.employeeName,
              attendanceDate: payload.attendanceDate,
              checkedInAt: payload.checkedInAt ?? null,
              status: payload.status as any,
              equivalentAbsence: 0,
              source: 'local'
            });
            // Also attempt to push to Google Sheets from central
            try {
              await this.pushAttendanceToGoogle(payload);
            } catch (e) {
              this.logger.warn('central_push_to_google_failed', { error: e instanceof Error ? e.message : String(e) });
            }
            processed += 1;
          } catch (inner) {
            this.logger.warn('central_process_payload_failed', { error: inner instanceof Error ? inner.message : String(inner) });
          }
        }
        res.json({ ok: true, processed });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Receive failed' });
      }
    });

    // Claim this machine as the single central host using the activation code.
    appServer.post('/admin/central', async (req, res) => {
      try {
        const result = await this.claimCentralMachine(String(req.body?.code ?? ''));
        res.json(result);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Failed' });
      }
    });
    appServer.get('/system/status', (_req, res) => res.json({ health: this.getHealth(), session: this.getSession() }));

    this.server = appServer.listen(0, '0.0.0.0', () => {
      const address = this.server?.address();
      if (address && typeof address === 'object') {
        this.port = address.port;
        process.env.NEXSTACK_API_PORT = String(this.port);
        try {
          fs.writeFileSync(path.join(app.getPath('userData'), 'api.port'), String(this.port), 'utf8');
        } catch (e) {
          this.logger.warn('write_port_file_failed', { error: e instanceof Error ? e.message : String(e) });
        }
        this.logger.info('api_started', { port: this.port });
      }
    });
  }

  private setupTray(): void {
    const preferredIcon = nativeImage.createFromPath(process.execPath);
    const trayIcon = preferredIcon.isEmpty() ? nativeImage.createEmpty() : preferredIcon;
    this.tray = new Tray(trayIcon);
    this.tray.setToolTip(APP_NAME);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open NexStackSolutions', click: () => this.mainWindow?.show() },
      { label: 'Sync Now', click: () => void this.syncNow() },
      { label: 'Exit', click: () => this.quitApplication() }
    ]);
    this.tray.setContextMenu(contextMenu);
    this.tray.on('double-click', () => this.mainWindow?.show());
  }

  private beginSchedulers(): void {
    this.timeTimer = setInterval(() => void this.getTrustedTime(), 5 * 60 * 1000);
    this.syncTimer = setInterval(() => void this.syncNow(), SYNC_INTERVAL_MS);
    this.reminderTimer = setInterval(() => void this.showReminderIfNeeded(), ATTENDANCE_REMINDER_INTERVAL_MS);
    void this.getTrustedTime();
    void this.showReminderIfNeeded();
  }

  private async showReminderIfNeeded(): Promise<void> {
    const session = this.getSession();
    if (!session) {
      return;
    }
    const status = await this.getStatus(session.employeeId);
    if (!status.isWithinAttendanceWindow || status.hasCheckedInToday) {
      this.hideReminderWindow();
      return;
    }
    if (!this.reminderWindow) {
      this.reminderWindow = new BrowserWindow({
        width: 420,
        height: 280,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        frame: false,
        backgroundColor: '#0c111b',
        webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false }
      });
      const reminderHtml = `
        <html><body style="margin:0;font-family:Segoe UI,sans-serif;background:#0c111b;color:#edf2fb;display:grid;place-items:center;height:100vh;text-align:center;">
          <div style="padding:24px;border:1px solid #27344d;border-radius:20px;background:#162033;box-shadow:0 16px 48px rgba(0,0,0,.35);width:100%;max-width:360px;">
            <div style="font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#92a0bb;">Attendance Reminder</div>
            <h1 style="margin:12px 0 8px;font-size:34px;">Please Check In</h1>
            <p style="margin:0 0 16px;color:#92a0bb;line-height:1.5;">${session.employeeName}, your shift is active. Attendance remains pending.</p>
            <button onclick="window.close()" style="border:0;border-radius:12px;padding:12px 18px;background:#44c2ff;color:#06111f;font-weight:700;cursor:pointer;">Dismiss</button>
          </div>
        </body></html>`;
      await this.reminderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(reminderHtml)}`);
      this.reminderWindow.setAlwaysOnTop(true, 'screen-saver');
      this.reminderWindow.on('closed', () => { this.reminderWindow = null; });
    } else {
      this.reminderWindow.show();
      this.reminderWindow.focus();
    }
  }

  private hideReminderWindow(): void {
    if (this.reminderWindow) {
      this.reminderWindow.hide();
    }
  }

  private registerWatchdog(): void {
    if (process.argv.includes('--watchdog')) {
      this.watchdogActive = true;
      return;
    }
    // Spawn a detached child that runs the same app and receives the --watchdog flag
    // Pass the app entry (process.argv[1]) first so Electron doesn't treat the PID as an app path
    const child = require('node:child_process').spawn(process.execPath, [process.argv[1] ?? '.', '--watchdog', String(process.pid)], { detached: true, stdio: 'ignore' });
    child.unref();
    this.watchdogActive = true;
    this.store.saveSetting('watchdogActive', 'true');
  }

  private getLocalIpv4(): string | null {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      const list = ifaces[name] ?? [];
      for (const info of list) {
        if (info.family === 'IPv4' && !info.internal) {
          return info.address;
        }
      }
    }
    return null;
  }

  private initializeUdpListener(): void {
    try {
      const socket = dgram.createSocket('udp4');
      socket.on('error', (err) => this.logger.warn('udp_error', { error: err.message }));
      socket.on('message', (msg, rinfo) => {
        try {
          const text = msg.toString('utf8');
          const data = JSON.parse(text);
          if (data && data.type === 'nexstack-central' && data.port) {
            // record the central endpoint
            const host = String(data.host ?? rinfo.address);
            const port = Number(data.port);
            this.store.addKnownCentral(host, port);
            this.store.saveSetting('centralHost', host);
            this.store.saveSetting('centralPort', String(port));
            this.logger.info('central_discovered', { host, port });
            void this.refreshRosterFromKnownCentrals();
          }
        } catch (e) {
          // ignore parse errors
        }
      });
      socket.bind(41234, () => {
        try {
          socket.setBroadcast(true);
        } catch (e) {
          // ignore
        }
        this.udpSocket = socket;
        this.logger.info('udp_listener_started', { port: 41234 });
        if (this.store.loadSetting('isCentral') === 'true') {
          this.startAnnouncer();
        }
      });
    } catch (error) {
      this.logger.warn('udp_init_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private startAnnouncer(): void {
    if (!this.udpSocket || this.announceTimer) return;
    const ip = this.getLocalIpv4() ?? '127.0.0.1';
    const payload = JSON.stringify({ type: 'nexstack-central', host: ip, port: this.port, name: APP_NAME });
    const buf = Buffer.from(payload, 'utf8');
    const send = () => {
      try {
        this.udpSocket?.send(buf, 0, buf.length, 41234, '255.255.255.255', (err) => {
          if (err) this.logger.warn('udp_announce_error', { error: err.message });
        });
      } catch (e) {
        // ignore
      }
    };
    send();
    this.announceTimer = setInterval(send, 15 * 1000);
    this.logger.info('udp_announcer_started');
  }

  private stopAnnouncer(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
  }

  private async pushPendingToCentrals(): Promise<void> {
    const centrals = this.store.listKnownCentrals();
    if (!centrals || centrals.length === 0) return;
    const queue = this.store.listPendingQueue();
    if (queue.length === 0) return;
    for (const central of centrals) {
      if (!this.store.loadSetting('syncToken')) {
        await this.refreshRosterFromKnownCentrals();
      }
      for (const item of queue) {
        try {
          const payload = this.store.decryptQueuePayload(item.payloadEncrypted) as unknown as SyncQueuePayload;
          const ok = await this.tryPushToCentral(central.host, central.port, payload);
          if (ok) {
            this.store.markQueueSynced(item.id, `Synced to central ${central.host}:${central.port}`);
          }
        } catch (e) {
          this.logger.warn('push_to_central_failed', { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  private async tryPushToCentral(host: string, port: number, payload: SyncQueuePayload): Promise<boolean> {
    try {
      const baseUrl = this.buildCentralBaseUrl(host, port);
      if (!baseUrl) {
        return false;
      }
      const url = `${baseUrl}/sync/receive`;
      const syncToken = this.store.loadSetting('syncToken') ?? '';
      if (!syncToken) {
        return false;
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nexstack-sync-token': syncToken },
        body: JSON.stringify(payload)
      });
      if (resp.ok) return true;
      if (resp.status === 403) {
        this.logger.warn('central_rejected_secret', { host, port });
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  private registerAutoStart(): void {
    if (process.platform !== 'win32') {
      return;
    }
    try {
      const args = app.isPackaged ? [] : [process.argv[1] ?? '.'];
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args,
        enabled: true
      });
      const state = app.getLoginItemSettings();
      if (state.openAtLogin) {
        this.store.saveSetting('autoStartEnabled', 'true');
        return;
      }
    } catch (error) {
      this.logger.warn('autostart_login_item_failed', { error: error instanceof Error ? error.message : String(error) });
    }

    const executable = process.execPath;
    const argSegment = app.isPackaged ? '' : ` \"${process.argv[1] ?? '.'}\"`;
    const command = `\"${executable}\"${argSegment}`;
    const reg = require('node:child_process').spawnSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', APP_NAME, '/t', 'REG_SZ', '/d', command, '/f'], { encoding: 'utf8' });
    if (reg.status !== 0) {
      this.store.saveSetting('autoStartEnabled', 'false');
      this.logger.warn('autostart_registration_failed', { stderr: reg.stderr });
    } else {
      this.store.saveSetting('autoStartEnabled', 'true');
    }
  }

  private quitApplication(): void {
    const appWithQuitFlag = app as Electron.App & { isQuitting?: boolean };
    appWithQuitFlag.isQuitting = true;
    try {
      this.tray?.destroy();
    } catch {
      // ignore tray cleanup failures during shutdown
    }
    app.quit();
  }
}