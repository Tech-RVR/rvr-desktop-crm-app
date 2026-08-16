'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer's ONLY window into the main process. contextIsolation is on
 * and nodeIntegration is off (see main.js), so this is the full, deliberate
 * surface area — nothing else in Node/Electron is reachable from app code.
 */
contextBridge.exposeInMainWorld('rvr', {
  auth: {
    login: (userName, password) => ipcRenderer.invoke('auth:login', { userName, password }),
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
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getOsLabel: () => ipcRenderer.invoke('app:getOsLabel'),
    reportRendererError: (payload) => ipcRenderer.invoke('app:reportRendererError', payload)
  }
});
