import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
let splashWindow: BrowserWindow | null = null;

function splashHtml(): string {
  const version = app.getVersion();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>NexStackSolutions</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Segoe UI", system-ui, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(68, 194, 255, 0.18), transparent 35%),
          radial-gradient(circle at bottom right, rgba(122, 92, 255, 0.16), transparent 32%),
          linear-gradient(160deg, #08101d, #0f1728 52%, #101827);
        color: #edf2fb;
      }
      .card {
        width: min(460px, calc(100vw - 2rem));
        border-radius: 20px;
        padding: 1.5rem;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(15, 23, 40, 0.92);
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
      }
      .company { font-size: 1.35rem; font-weight: 800; letter-spacing: 0.04em; }
      .meta { margin-top: 0.35rem; color: #9eacc6; }
      .status {
        margin-top: 1.1rem;
        display: inline-flex;
        align-items: center;
        gap: 0.6rem;
        color: #d6e8ff;
      }
      .dot {
        width: 0.8rem;
        height: 0.8rem;
        border-radius: 999px;
        background: #44c2ff;
        box-shadow: 0 0 0 0 rgba(68, 194, 255, 0.7);
        animation: pulse 1.2s ease-in-out infinite;
      }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(68, 194, 255, 0.7); }
        70% { box-shadow: 0 0 0 10px rgba(68, 194, 255, 0); }
        100% { box-shadow: 0 0 0 0 rgba(68, 194, 255, 0); }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="company">NexStackSolutions</div>
      <div class="meta">Version ${version}</div>
      <div class="status"><span class="dot" aria-hidden="true"></span><span>Checking for updates...</span></div>
    </div>
  </body>
</html>`;
}

function createSplashWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 520,
    height: 300,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    transparent: false,
    show: true,
    center: true,
    alwaysOnTop: true,
    title: 'NexStackSolutions',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml())}`);
  return window;
}

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
  splashWindow = createSplashWindow();
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
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      try {
        // eslint-disable-next-line no-console
        console.error('renderer_load_failed', { errorCode, errorDescription, validatedURL });
      } catch {
        // ignore console failures in packaged environments
      }
    });
    if (devServerUrl) {
      await mainWindow.loadURL(devServerUrl);
    } else {
      await mainWindow.loadURL(pathToFileURL(path.join(app.getAppPath(), 'dist/renderer/index.html')).toString());
    }

    // Keep splash visible while update check completes, but avoid blocking forever.
    await Promise.race([
      backend.checkForUpdatesAtStartup().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.warn('update_check_failed', message);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 15000))
    ]);

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    splashWindow = null;
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow?.once('ready-to-show', () => mainWindow?.show());
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      // eslint-disable-next-line no-console
      console.error('bootstrap_failed', message);
    } catch {
      // ignore console failures in packaged environments
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    splashWindow = null;
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
