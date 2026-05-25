import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';

// Load .env from project root during development and when running unpackaged
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
} catch {
  // ignore if dotenv isn't available in runtime
}

function loadUserDataEnv(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dotenv = require('dotenv');
    const userDataEnvPath = path.join(app.getPath('userData'), 'nexstacksolutions.env');
    dotenv.config({ path: userDataEnvPath });
  } catch {
    // ignore if user-data env is not present
  }
}

import { NexStackBackend } from './backend';

let backend: NexStackBackend | null = null;
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1280,
    minHeight: 820,
    show: false,
    backgroundColor: '#0c111b',
    title: 'NexStackSolutions',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.on('close', (event) => {
    if (!(app as AppWithQuitFlag).isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  return window;
}

async function bootstrap(): Promise<void> {
  loadUserDataEnv();
  backend = new NexStackBackend();
  mainWindow = createMainWindow();
  try {
    const port = await backend.start(mainWindow);
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.send('backend:port', port);
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    });
    if (devServerUrl) {
      await mainWindow.loadURL(devServerUrl);
    } else {
      await mainWindow.loadFile(path.join(app.getAppPath(), 'dist/renderer/index.html'));
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.once('ready-to-show', () => mainWindow?.show());
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      // eslint-disable-next-line no-console
      console.error('bootstrap_failed', message);
    } catch {
      // ignore console failures in packaged environments
    }
    throw error;
  }
}

if (process.argv.includes('--watchdog')) {
  const parentPid = Number(process.argv[process.argv.indexOf('--watchdog') + 1] ?? 0);
  const interval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(interval);
      // Relaunch the app with the original entry path.
      require('node:child_process').spawn(process.execPath, [process.argv[1] ?? '.'], { detached: true, stdio: 'ignore' }).unref();
      process.exit(0);
    }
  }, 5000);
} else {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  }

  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    void bootstrap();
  });

  app.on('window-all-closed', () => {
    return;
  });

  app.on('before-quit', () => {
    (app as AppWithQuitFlag).isQuitting = true;
  });

  ipcMain.handle('app:quit', () => {
    (app as AppWithQuitFlag).isQuitting = true;
    app.quit();
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });
}

interface AppWithQuitFlag extends Electron.App {
  isQuitting?: boolean;
}
