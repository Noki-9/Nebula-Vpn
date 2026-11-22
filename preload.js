'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, callback) {
  const handler = (event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  getState: () => invoke('state:get'),

  selectServer: (id) => invoke('server:select', id),
  testLatency: (id) => invoke('server:latency', id || null),
  deleteServer: (id) => invoke('server:delete', id),
  addLink: (link) => invoke('server:add', { link }),

  addSubscription: (url, name) => invoke('sub:add', { url, name }),
  updateSubscription: (id) => invoke('sub:update', id),
  removeSubscription: (id) => invoke('sub:remove', id),

  setSettings: (patch) => invoke('settings:set', patch),

  connect: () => invoke('connect'),
  disconnect: () => invoke('disconnect'),

  clearLogs: () => invoke('logs:clear'),
  pickExe: () => invoke('dialog:pick-exe'),
  openFolder: () => invoke('core:open-folder'),
  openExternal: (url) => invoke('shell:open', url),
  restartAdmin: () => invoke('app:restart-admin'),

  window: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
  },

  onState: (callback) => subscribe('state', callback),
  onTraffic: (callback) => subscribe('traffic', callback),
  onLog: (callback) => subscribe('log', callback),
});
