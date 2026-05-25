import { contextBridge, ipcRenderer } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppStatus, AttendanceRecord, EmployeeRecord, SystemHealthSnapshot } from '../shared/types';

let backendPort: string | null = process.env.NEXSTACK_API_PORT ?? null;
let resolveBackendReady: ((port: string) => void) | null = null;
const backendReady = new Promise<number>((resolve) => {
  let resolved = false;

  const doResolve = (port: number) => {
    if (!resolved) {
      resolved = true;
      console.info('preload: backend port resolved', port);
      resolve(Number(port));
    }
  };

  ipcRenderer.on('backend:port', (_ev, port) => {
    doResolve(Number(port));
  });

  // If main process set env before preload, use it as a quick fallback
  const envPort = process.env.NEXSTACK_API_PORT;
  if (envPort) {
    console.info('preload: found NEXSTACK_API_PORT in env', envPort);
    doResolve(Number(envPort));
  }

  // Final fallback: try to read the port file written by main (userData/api.port)
  const tryReadPortFile = () => {
    try {
      const userData = path.join(process.env.APPDATA || '', 'nexstacksolutions');
      const filePath = path.join(userData, 'api.port');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) {
          console.info('preload: read api.port file', filePath, content);
          doResolve(Number(content));
          return true;
        }
      }
    } catch (e) {
      console.info('preload: api.port read error', e instanceof Error ? e.message : String(e));
    }
    return false;
  };

  // Poll for the file for a short period if nothing else resolved yet
  let attempts = 0;
  const maxAttempts = 20;
  const poll = () => {
    if (resolved) return;
    attempts++;
    if (tryReadPortFile()) return;
    if (attempts < maxAttempts) {
      setTimeout(poll, 200);
    }
  };
  poll();
});

ipcRenderer.on('backend:port', (_event, port: number) => {
  backendPort = String(port);
  if (resolveBackendReady) {
    resolveBackendReady(backendPort);
    resolveBackendReady = null;
  }
  // diagnostic
  try {
    // eslint-disable-next-line no-console
    console.info('preload: received backend:port', backendPort);
  } catch {}
});

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const port = await backendReady;
  // diagnostic
  try {
    // eslint-disable-next-line no-console
    console.info('preload: fetchJson', path, 'port', port);
  } catch {}
  if (!port) {
    throw new Error('Backend is not ready yet');
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String((payload as { error?: string }).error ?? `Request failed with ${response.status}`));
  }
  return response.json() as Promise<T>;
}

contextBridge.exposeInMainWorld('nexStack', {
  bootstrap: async (): Promise<{ session: EmployeeRecord | null; status: AppStatus; health: SystemHealthSnapshot }> => fetchJson('/auth/bootstrap'),
  login: async (employeeId: string): Promise<{ session: EmployeeRecord; status: AppStatus }> => {
    return fetchJson('/auth/login', { method: 'POST', body: JSON.stringify({ employeeId, machineInfo: await getMachineInfo() }) });
  },
  logout: async (): Promise<void> => { await fetchJson('/auth/logout', { method: 'POST' }); },
  getDashboard: async (): Promise<{ status: AppStatus; attendance: AttendanceRecord[]; reports: unknown }> => fetchJson('/attendance/dashboard'),
  checkIn: async (): Promise<{ ok: boolean; message: string; status: AppStatus; record?: AttendanceRecord }> => fetchJson('/attendance/check-in', { method: 'POST', body: JSON.stringify({ machineInfo: await getMachineInfo() }) }),
  getMachineInfo
});

async function getMachineInfo(): Promise<{ machineName: string; windowsUser: string; deviceFingerprint: string; ipAddress: string }> {
  const os = await import('node:os');
  const crypto = await import('node:crypto');
  const machineName = os.hostname();
  const windowsUser = process.env.USERNAME ?? os.userInfo().username;
  const networkInterfaces = os.networkInterfaces();
  const adapters = Object.values(networkInterfaces).flat() as Array<{ internal: boolean; mac: string; family: string; address: string }>;
  const macAddresses = adapters.filter((item) => !item.internal).map((item) => item.mac).sort().join('|');
  const deviceFingerprint = crypto.createHash('sha256').update([machineName, windowsUser, process.platform, process.arch, macAddresses].join('|')).digest('hex');
  const ipAddress = adapters.find((item) => !item.internal && item.family === 'IPv4')?.address ?? '127.0.0.1';
  return { machineName, windowsUser, deviceFingerprint, ipAddress };
}