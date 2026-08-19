'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer's ONLY window into the main process. contextIsolation is on
 * and nodeIntegration is off (see main.js), so this is the full, deliberate
 * surface area — nothing else in Node/Electron is reachable from app code.
 */
contextBridge.exposeInMainWorld('rvr', {
  auth: {
    // `code` is optional — only sent when the account has EspoCRM's own 2FA
    // turned on and the login screen is on its second step.
    login: (userName, password, code) => ipcRenderer.invoke('auth:login', { userName, password, code }),
    logout: () => ipcRenderer.invoke('auth:logout'),
    lastUserName: () => ipcRenderer.invoke('auth:lastUserName'),
    forgotPasswordUrl: () => ipcRenderer.invoke('auth:forgotPasswordUrl')
  },
  espo: {
    // Generic authenticated EspoCRM request, e.g.:
    //   window.rvr.espo.request('Case', { query: { maxSize: 20 } })
    request: (path, opts) => ipcRenderer.invoke('espo:request', { path, ...(opts || {}) }),
    // Downloads an Attachment's file bytes using the logged-in user's own
    // credentials and prompts a native Save dialog. The auth header never
    // reaches the renderer.
    downloadFile: (fileId, fileName) => ipcRenderer.invoke('espo:downloadFile', { fileId, fileName })
  },
  claimPool: {
    list: () => ipcRenderer.invoke('claimPool:list'),
    submit: (caseId, staffUserId) => ipcRenderer.invoke('claimPool:submit', { caseId, staffUserId })
  },
  clock: {
    myCases: (staffUserId) => ipcRenderer.invoke('clock:myCases', { staffUserId }),
    event: (payload) => ipcRenderer.invoke('clock:event', payload)
  },
  feedback: {
    submit: (payload) => ipcRenderer.invoke('feedback:submit', payload)
  },
  security: {
    // Director/Administrator-role only — see security.js. Goes through a
    // dedicated n8n webhook, never a direct EspoCRM call, since no staff
    // login (however senior) has ACL rights to touch another user's
    // password field directly. Enforced server-side; the app's own gating
    // is just a convenience so non-admins never see the control.
    resetColleaguePassword: (targetUserId) => ipcRenderer.invoke('security:resetColleaguePassword', { targetUserId })
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getOsLabel: () => ipcRenderer.invoke('app:getOsLabel'),
    reportRendererError: (payload) => ipcRenderer.invoke('app:reportRendererError', payload)
  },
  messages: {
    // Local-only "what have I already seen" tracking for the Messages
    // screen's unread badge — see main.js's Store defaults comment.
    getSeen: () => ipcRenderer.invoke('messages:getSeen'),
    setSeen: (caseId, timestamp) => ipcRenderer.invoke('messages:setSeen', { caseId, timestamp })
  },
  onboarding: {
    // Per-user first-run tour state — see main.js's onboarding:getState/
    // setState handlers for why this is keyed by EspoCRM user id rather
    // than per-install like messages.getSeen above.
    getState: (userId) => ipcRenderer.invoke('onboarding:getState', { userId }),
    setState: (userId, patch) => ipcRenderer.invoke('onboarding:setState', { userId, patch })
  }
});
