PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS Session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employeeId TEXT NOT NULL,
  role TEXT NOT NULL,
  tokenEncrypted TEXT NOT NULL,
  machineFingerprint TEXT NOT NULL,
  lastLoginAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS AttendanceQueue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employeeId TEXT NOT NULL,
  employeeName TEXT NOT NULL,
  attendanceDate TEXT NOT NULL,
  checkedInAt TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  payloadEncrypted TEXT NOT NULL,
  syncStatus TEXT NOT NULL DEFAULT 'pending',
  attemptCount INTEGER NOT NULL DEFAULT 0,
  nextRetryAt TEXT,
  lastError TEXT,
  syncedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS DeviceInfo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employeeId TEXT,
  machineName TEXT NOT NULL,
  windowsUser TEXT NOT NULL,
  deviceFingerprint TEXT NOT NULL UNIQUE,
  assignedDeviceId TEXT,
  ipAddress TEXT,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  isUnexpected INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS AttendanceCache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employeeId TEXT NOT NULL,
  employeeName TEXT NOT NULL,
  attendanceDate TEXT NOT NULL,
  checkedInAt TEXT,
  status TEXT NOT NULL,
  equivalentAbsence INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employeeId, attendanceDate)
);

CREATE TABLE IF NOT EXISTS SyncLogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entityType TEXT NOT NULL,
  entityId TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS AuditCache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  adminId TEXT NOT NULL,
  employeeId TEXT,
  action TEXT NOT NULL,
  oldValue TEXT,
  newValue TEXT,
  reason TEXT NOT NULL,
  machineName TEXT,
  windowsUser TEXT,
  deviceFingerprint TEXT,
  ipAddress TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS SystemHealth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  value TEXT NOT NULL,
  severity TEXT NOT NULL,
  recordedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS EmployeeCache (
  employeeId TEXT PRIMARY KEY,
  employeeName TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  assignedDeviceId TEXT,
  sourceVersion TEXT,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS Settings (
  key TEXT PRIMARY KEY,
  valueEncrypted TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);