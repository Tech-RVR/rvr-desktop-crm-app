'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');

const { EspoClient, EspoAuthError, BASE_URL } = require('./espoClient');
const { n8nClient } = require('./n8nClient');

const store = new Store({
  name: 'rvr-crm-preferences',
  // Only non-sensitive preferences live here — never a password or auth token.
  defaults: { lastUserName: '', windowBounds: null }
});

const espo = new EspoClient();

let mainWindow = null;
let appVersion = app.getVersion();

function getOsLabel() {
  const platform = process.platform;
  if (platform === 'win32') return `Windows (${process.getSystemVersion ? process.getSystemVersion() : 'unknown build'})`;
  if (platform === 'darwin') return `macOS (${process.getSystemVersion ? process.getSystemVersion() : 'unknown build'})`;
  return platform;
}

function currentStaffName() {
  const info = espo.getSessionInfo();
  return info.userName || '(not logged in)';
}

/**
 * Background error capture — Electron main + renderer process error handlers
 * both funnel here, which reports to the App Error Tracking n8n workflow.
 * Deliberately no AI/LLM involvement; raw and readable only, per the
 * standing "no LLM calls at runtime" project principle.
 */
function reportError({ errorMessage, stackTrace, userAction }) {
  n8nClient
    .reportError({
      errorMessage: errorMessage || 'Unknown error',
      stackTrace: stackTrace || '(no stack trace)',
      userAction: userAction || '(not supplied)',
      appVersion,
      os: getOsLabel(),
      staffName: currentStaffName(),
      timestamp: new Date().toISOString()
    })
    .catch(() => {
      // Deliberately swallow — we don't want error reporting itself to crash
      // the app or surface a second error to the user.
    });
}

process.on('uncaughtException', (err) => {
  reportError({ errorMessage: err.message, stackTrace: err.stack, userAction: 'Background (main process uncaught exception)' });
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  reportError({ errorMessage: err.message, stackTrace: err.stack, userAction: 'Background (main process unhandled rejection)' });
});

function createWindow() {
  const bounds = store.get('windowBounds') || { width: 1280, height: 820 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#F2EFE7',
    title: 'RVR Ratings CRM',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('resize', () => {
    if (mainWindow) store.set('windowBounds', mainWindow.getBounds());
  });

  // Open any external links (e.g. "www.rvrratingpartners.co.uk" footer link)
  // in the OS default browser rather than inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();

  if (!process.env.NODE_ENV || process.env.NODE_ENV === 'production') {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // Non-fatal — the app should still be usable if the update check fails
      // (e.g. no network, GitHub Releases briefly unreachable).
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers — the ONLY surface the renderer can reach (via the preload
// contextBridge). The renderer never talks to EspoCRM or n8n directly.
// ---------------------------------------------------------------------------

ipcMain.handle('auth:login', async (_event, { userName, password }) => {
  try {
    const user = await espo.login(userName, password);
    store.set('lastUserName', userName);
    return { ok: true, user };
  } catch (err) {
    const status = err instanceof EspoAuthError ? err.status : undefined;
    return { ok: false, message: err.message, status };
  }
});

ipcMain.handle('auth:logout', async () => {
  espo.logout();
  return { ok: true };
});

ipcMain.handle('auth:lastUserName', async () => store.get('lastUserName') || '');

ipcMain.handle('auth:forgotPasswordUrl', async () => {
  // EspoCRM's own native forgot-password flow (Administration → Group Email
  // Accounts SMTP, confirmed working 2026-08-10) — the app links out to the
  // real login page rather than re-implementing password recovery itself.
  return 'https://crm.rvrratingpartners.co.uk/';
});

ipcMain.handle('espo:request', async (_event, { path: reqPath, method, query, body }) => {
  try {
    const data = await espo.request(reqPath, { method, query, body });
    return { ok: true, data };
  } catch (err) {
    const status = err instanceof EspoAuthError ? err.status : undefined;
    return { ok: false, message: err.message, status };
  }
});

ipcMain.handle('claimPool:list', async () => {
  const res = await n8nClient.listClaimableCases();
  return res;
});

ipcMain.handle('claimPool:submit', async (_event, { caseId, staffUserId }) => {
  const res = await n8nClient.submitClaim(caseId, staffUserId);
  return res;
});

ipcMain.handle('clock:myCases', async (_event, { staffUserId }) => {
  const res = await n8nClient.listMyCases(staffUserId);
  return res;
});

ipcMain.handle('clock:event', async (_event, payload) => {
  const res = await n8nClient.clockEvent(payload);
  return res;
});

ipcMain.handle('feedback:submit', async (_event, payload) => {
  const res = await n8nClient.submitFeedback({
    ...payload,
    staffName: payload.staffName || currentStaffName(),
    timestamp: new Date().toISOString()
  });
  return res;
});

ipcMain.handle('app:reportRendererError', async (_event, { errorMessage, stackTrace, userAction }) => {
  reportError({ errorMessage, stackTrace, userAction });
  return { ok: true };
});

ipcMain.handle('app:getVersion', async () => appVersion);
ipcMain.handle('app:getOsLabel', async () => getOsLabel());
