import React, { useEffect, useMemo, useState } from 'react';
import type { AppStatus, AttendanceRecord, EmployeeRecord, SystemHealthSnapshot } from '../shared/types';

declare global {
  interface Window {
    nexStack: {
      bootstrap(): Promise<{ session: EmployeeRecord | null; status: AppStatus; health: SystemHealthSnapshot }>;
      login(employeeId: string): Promise<{ session: EmployeeRecord; status: AppStatus }>;
      logout(): Promise<void>;
      getDashboard(): Promise<{ status: AppStatus; attendance: AttendanceRecord[]; reports: unknown }>;
      checkIn(): Promise<{ ok: boolean; message: string; status: AppStatus; record?: AttendanceRecord }>;
    };
  }
}

function formatStatusBadge(status: string): string {
  return status.toUpperCase();
}

function format24HourTimeTo12Hour(value: string): string {
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return value;
  }
  const hours24 = Number(match[1]);
  const minutes = match[2];
  const seconds = match[3];
  if (Number.isNaN(hours24) || hours24 < 0 || hours24 > 23) {
    return value;
  }
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return seconds ? `${hours12}:${minutes}:${seconds} ${suffix}` : `${hours12}:${minutes} ${suffix}`;
}

function formatDateTimeTo12Hour(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) {
    return value;
  }
  const datePart = match[1];
  const timePart = match[2];
  return `${datePart} ${format24HourTimeTo12Hour(timePart)}`;
}

export default function App() {
  const [bootState, setBootState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<EmployeeRecord | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [health, setHealth] = useState<SystemHealthSnapshot | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [message, setMessage] = useState('');
  const [busyAction, setBusyAction] = useState<'boot' | 'login' | 'checkin' | 'refresh' | null>('boot');

  useEffect(() => {
    let mounted = true;
    const bridge = (window as unknown as Window).nexStack;
    if (!bridge) {
      setError('Renderer bridge not available. Make sure you started the app via Electron (npm run dev) so the preload script is loaded.');
      setBootState('error');
      return;
    }
    bridge.bootstrap().then(({ session: currentSession, status: currentStatus, health: currentHealth }) => {
      if (!mounted) {
        return;
      }
      setSession(currentSession);
      setStatus(currentStatus);
      setHealth(currentHealth);
      setBusyAction(null);
      setBootState('ready');
    }).catch((bootError: unknown) => {
      if (!mounted) {
        return;
      }
      setError(bootError instanceof Error ? bootError.message : 'Unable to initialize NexStackSolutions');
      setBusyAction(null);
      setBootState('error');
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setAttendance([]);
      return;
    }
    setBusyAction('refresh');
    window.nexStack.getDashboard().then((dashboard) => {
      setStatus(dashboard.status);
      setAttendance(dashboard.attendance);
      setBusyAction(null);
    }).catch((dashboardError: unknown) => {
      setMessage(dashboardError instanceof Error ? dashboardError.message : 'Failed to refresh dashboard');
      setBusyAction(null);
    });
  }, [session]);

  const summary = useMemo(() => {
    if (!status) {
      return 'Loading current status';
    }
    return `${format24HourTimeTo12Hour(status.currentTimePkt)} PKT · ${status.statusText}`;
  }, [status]);

  async function handleLogin(): Promise<void> {
    setBusyAction('login');
    try {
      const result = await window.nexStack.login(employeeId.trim());
      setSession(result.session);
      setStatus(result.status);
      setMessage('Login successful');
    } catch (loginError) {
      setMessage(loginError instanceof Error ? loginError.message : 'Login failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCheckIn(): Promise<void> {
    setBusyAction('checkin');
    try {
      const result = await window.nexStack.checkIn();
      setStatus(result.status);
      if (result.record) {
        setAttendance((current) => [result.record as AttendanceRecord, ...current.filter((item) => item.attendanceDate !== result.record?.attendanceDate)]);
      }
      setMessage(result.message);
    } catch (checkInError) {
      setMessage(checkInError instanceof Error ? checkInError.message : 'Check-in failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLogout(): Promise<void> {
    await window.nexStack.logout();
    setSession(null);
    setAttendance([]);
    setMessage('Logged out');
  }

  if (bootState === 'loading') {
    return (
      <div className="shell loading-shell">
        <div className="loading-card">
          <div className="loading-logo">NexStackSolutions</div>
          <div className="loader-ring" />
          <p>Booting the portal and checking local services...</p>
        </div>
      </div>
    );
  }

  if (bootState === 'error') {
    return (
      <div className="shell error-shell">
        <h1>NexStackSolutions failed to start</h1>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand">NexStackSolutions</div>
          <div className="subtitle">IT Operations Portal</div>
        </div>
        <div className="panel">
          <div className="panel-title">Current Session</div>
          <div className="panel-value">{session ? session.employeeName : 'No active employee'}</div>
          <div className="panel-meta">{summary}</div>
        </div>
        <div className="panel">
          <div className="panel-title">System Health</div>
          <div className="panel-value">{health?.internetAvailable ? 'Online sync ready' : 'Offline mode active'}</div>
          <div className="panel-meta">Queue depth: {health?.syncQueueDepth ?? 0}</div>
        </div>
      </aside>

      <main className="main">
        {!session ? (
          <section className="login-card">
            <h1>Employee Login</h1>
            <p>Enter Employee ID to continue. No password is required.</p>
            <input value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} placeholder="EMP001" />
            <button onClick={handleLogin} disabled={busyAction === 'login'}>
              {busyAction === 'login' ? <span className="button-loader" aria-hidden="true" /> : null}
              <span>{busyAction === 'login' ? 'Signing In...' : 'Continue'}</span>
            </button>
            {message ? <div className="notice">{message}</div> : null}
          </section>
        ) : (
          <section className="dashboard-grid">
            <article className="hero-card">
              <div className="hero-top">
                <div>
                  <div className="hero-label">Employee</div>
                  <h1>{session.employeeName}</h1>
                </div>
                <span className={`status-pill status-${status?.hasCheckedInToday ? 'ok' : 'warn'}`}>
                  {status?.hasCheckedInToday ? 'Already Checked In' : 'Awaiting Check-In'}
                </span>
              </div>
              <div className="hero-details">
                <div><span>Role</span><strong>{session.role}</strong></div>
                <div><span>Current Time</span><strong>{status ? format24HourTimeTo12Hour(status.currentTimePkt) : '-'} PKT</strong></div>
                <div><span>Shift</span><strong>{status ? format24HourTimeTo12Hour(status.shiftStartPkt) : '-'} to {status ? format24HourTimeTo12Hour(status.shiftEndPkt) : '-'}</strong></div>
                <div><span>Late Threshold</span><strong>{status ? format24HourTimeTo12Hour(status.lateThresholdPkt) : '-'} PKT</strong></div>
              </div>
              <div className="hero-actions">
                <button className="primary" onClick={handleCheckIn} disabled={Boolean(status?.hasCheckedInToday || busyAction === 'checkin' || health?.internetAvailable === false)}>
                  {busyAction === 'checkin' ? <span className="button-loader" aria-hidden="true" /> : null}
                  <span>{status?.hasCheckedInToday ? 'Checked In' : health?.internetAvailable === false ? 'Internet Required' : busyAction === 'checkin' ? 'Checking In...' : 'Check In'}</span>
                </button>
                <button onClick={handleLogout}>Logout</button>
              </div>
              {message ? <div className="notice">{message}</div> : null}
            </article>

            <article className="records-card">
              <div className="section-head">
                <h2>Today's Status</h2>
                <span className="muted">{status?.attendanceDate}</span>
              </div>
              <div className="record-list">
                {attendance.length === 0 ? <div className="empty-state">No local records loaded yet.</div> : null}
                {attendance.map((item) => (
                  <div key={`${item.employeeId}-${item.attendanceDate}`} className="record-row">
                    <div>
                      <strong>{item.employeeName}</strong>
                      <div className="muted">{item.attendanceDate}</div>
                    </div>
                    <div className="align-right">
                      <strong>{item.checkedInAt ? formatDateTimeTo12Hour(item.checkedInAt) : 'Absent'}</strong>
                      <div className={`status-mini status-${item.status.toLowerCase()}`}>{formatStatusBadge(item.status)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        )}
      </main>
    </div>
  );
}