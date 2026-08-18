'use strict';

const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');

const { EspoClient, EspoAuthError, BASE_URL } = require('./espoClient');
const { n8nClient } = require('./n8nClient');

const store = new Store({
  name: 'rvr-crm-preferences',
  // Only non-sensitive preferences live here — never a password or auth token.
  // seenMessagesAt: { [caseId]: isoTimestamp } — the newest portal-message
  // createdAt this staff member has actually opened/viewed on that case, used
  // purely client-side to drive the unread badge/poll (Messages screen).
  // Per-install, not per-user — acceptable since the app is single-user per
  // machine login session and this is a convenience indicator, not a source
  // of truth (EspoCRM's own createdAt timestamps are that).
  defaults: { lastUserName: '', windowBounds: null, seenMessagesAt: {}, onboarding: {} }
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

/**
 * 2026-08-18: prompted by a real gap — David hit a bare EspoCRM 403
 * (org-wide 2FA setting was off) that showed a friendly inline error in the
 * app, exactly as designed, and therefore never surfaced anywhere: it wasn't
 * an uncaught exception or an unhandled rejection, so App Error Tracking
 * never fired and Tyrone never heard about it until David mentioned it
 * directly. This closes that specific gap for API-call failures without
 * changing what staff see on screen at all — every screen still shows its
 * own friendly inline message exactly as before; this only adds a silent,
 * additional report to `tech@` for the subset that looks like a genuine bug.
 *
 * "Unexpected" here means: NOT a routine 401 (not logged in / session
 * expired / wrong password / needs a 2FA code — all normal, frequent,
 * staff-facing outcomes not worth an email), and NOT an error EspoCRM itself
 * gave a specific, known reason for (a validation message, a real
 * permission explanation). Everything else — a bare/generic failure with no
 * reason given, a malformed response, a network-level error — gets reported
 * in the background, in addition to (never instead of) the on-screen
 * message. See espoClient.js's `EspoAuthError.expected` for where each
 * failure path decides which bucket it's in.
 */
function reportUnexpectedApiFailure(err, userAction) {
  const isAuthErr = err instanceof EspoAuthError;
  const status = isAuthErr ? err.status : undefined;
  const expected = isAuthErr ? !!err.expected : false;

  if (status === 401) return;
  if (expected) return;

  reportError({
    errorMessage: err && err.message ? err.message : String(err),
    stackTrace: err && err.stack ? err.stack : '(no stack trace)',
    userAction
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

// ---------------------------------------------------------------------------
// Auto-update.
//
// 0.2.3 and earlier called checkForUpdatesAndNotify() once, at launch, and
// relied on autoInstallOnAppQuit. That meant a staff member had to restart
// once to trigger the check, wait for a silent background download, then quit
// and reopen — and the assisted NSIS installer put up its own Next/Install
// wizard on the way. Three steps and a wizard to pick up a bug fix.
//
// Now: check at launch AND on a timer, then offer one button. "Restart now"
// runs the installer silently and relaunches the app itself, so the whole
// update is a single click with no wizard.
// ---------------------------------------------------------------------------
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;   // every 30 minutes
const UPDATE_REMIND_LATER_MS = 60 * 60 * 1000;     // re-ask an hour after "Later"

let updatePromptOpen = false;
let updateRemindTimer = null;

function promptToInstallUpdate(version) {
  if (updatePromptOpen) return;
  updatePromptOpen = true;
  clearTimeout(updateRemindTimer);

  const options = {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `RVR Ratings CRM ${version || ''} is ready to install.`.replace('  ', ' '),
    detail: 'The app will close and reopen on its own — it takes a few seconds. Nothing in the CRM is affected.'
  };

  const shown = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);

  shown
    .then((result) => {
      updatePromptOpen = false;
      if (result.response === 0) {
        // isSilent: true skips the NSIS wizard; isForceRunAfter: true reopens
        // the app once it's done. Deferred to the next tick so the dialog is
        // fully closed before the app starts tearing down.
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
        return;
      }
      // "Later" — the update is already downloaded and autoInstallOnAppQuit
      // stays on, so quitting normally still applies it. Ask again in an hour
      // in case they leave the app open for days.
      updateRemindTimer = setTimeout(() => promptToInstallUpdate(version), UPDATE_REMIND_LATER_MS);
    })
    .catch(() => { updatePromptOpen = false; });
}

function initAutoUpdate() {
  // Never check in dev — it would try to read a release feed for a version
  // that doesn't exist and log noise on every run.
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'production') return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => promptToInstallUpdate(info && info.version));

  // Non-fatal by design: no network, GitHub briefly unreachable, or a rate
  // limit should never interrupt someone mid-case. The next timer tick retries.
  autoUpdater.on('error', () => {});

  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(() => {
  createWindow();

  // Field clock-in needs GPS. Electron denies permission requests by default,
  // so the renderer's navigator.geolocation call would otherwise silently
  // reject. Only geolocation is allowed here — everything else (camera, mic,
  // notifications, etc.) stays denied since the app has no use for it.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'geolocation');
  });

  initAutoUpdate();

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

ipcMain.handle('auth:login', async (_event, { userName, password, code }) => {
  try {
    const user = await espo.login(userName, password, code);
    store.set('lastUserName', userName);
    return { ok: true, user };
  } catch (err) {
    const status = err instanceof EspoAuthError ? err.status : undefined;
    const secondStepRequired = err instanceof EspoAuthError ? !!err.secondStepRequired : false;
    reportUnexpectedApiFailure(err, `Signing in as "${userName || '(blank)'}"`);
    return { ok: false, message: err.message, status, secondStepRequired };
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
    reportUnexpectedApiFailure(err, `API call: ${method || 'GET'} ${reqPath}`);
    return { ok: false, message: err.message, status };
  }
});

ipcMain.handle('espo:downloadFile', async (_event, { fileId, fileName }) => {
  try {
    const buffer = await espo.downloadFile(fileId);
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: fileName || 'document',
      title: 'Save document'
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, canceled: true };
    }
    require('fs').writeFileSync(saveResult.filePath, buffer);
    return { ok: true, path: saveResult.filePath };
  } catch (err) {
    const status = err instanceof EspoAuthError ? err.status : undefined;
    reportUnexpectedApiFailure(err, `Downloading file ${fileId}`);
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

// ---------------------------------------------------------------------------
// Local "seen" tracking for the Messages screen's unread badge — purely a
// per-install convenience (see the Store defaults comment above), never
// treated as authoritative.
// ---------------------------------------------------------------------------
ipcMain.handle('messages:getSeen', async () => store.get('seenMessagesAt') || {});

ipcMain.handle('messages:setSeen', async (_event, { caseId, timestamp }) => {
  if (!caseId || !timestamp) return { ok: false };
  const map = store.get('seenMessagesAt') || {};
  // Only ever move forward — never let an out-of-order call mark an older
  // message as the "latest seen" and resurrect an already-cleared badge.
  if (!map[caseId] || new Date(timestamp) > new Date(map[caseId])) {
    map[caseId] = timestamp;
    store.set('seenMessagesAt', map);
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Onboarding — first-run tour. Per-user (not per-install, unlike
// seenMessagesAt above) since whether a given staff member has seen the
// tour is a property of the person, not the machine — matters specifically
// for the Surveyor role, where individual accounts rotate through shared
// machines over time (see the project's surveyor-rolling-role-sop.md).
// Keyed by EspoCRM user id. Shape per user: { hasSeenTour, dontShowAgain }.
// (lastSeenVersion / seenFeatureHighlights are reserved for the "what's
// new on update" follow-up feature — not used yet.)
// ---------------------------------------------------------------------------
ipcMain.handle('onboarding:getState', async (_event, { userId }) => {
  if (!userId) return {};
  const all = store.get('onboarding') || {};
  return all[userId] || {};
});

ipcMain.handle('onboarding:setState', async (_event, { userId, patch }) => {
  if (!userId || !patch) return { ok: false };
  const all = store.get('onboarding') || {};
  all[userId] = { ...(all[userId] || {}), ...patch };
  store.set('onboarding', all);
  return { ok: true };
});
