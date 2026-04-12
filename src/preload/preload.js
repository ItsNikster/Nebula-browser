const { contextBridge, ipcRenderer } = require('electron');

function deepFreeze(target) {
  Object.freeze(target);
  for (const value of Object.values(target)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return target;
}

const api = {
  bootstrap: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on('state:update', wrapped);
    return () => ipcRenderer.removeListener('state:update', wrapped);
  },
  onCommand: (callback) => {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on('ui:command', wrapped);
    return () => ipcRenderer.removeListener('ui:command', wrapped);
  },
  browser: {
    newTab: (url) => ipcRenderer.invoke('browser:new-tab', { url }),
    switchTab: (tabId) => ipcRenderer.invoke('browser:switch-tab', { tabId }),
    closeTab: (tabId) => ipcRenderer.invoke('browser:close-tab', { tabId }),
    navigate: (url) => ipcRenderer.invoke('browser:navigate', { url }),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: (ignoreCache = false) => ipcRenderer.invoke('browser:reload', { ignoreCache })
  },
  profiles: {
    create: (name) => ipcRenderer.invoke('profiles:create', { name }),
    switch: (profileId) => ipcRenderer.invoke('profiles:switch', { profileId }),
    remove: (profileId) => ipcRenderer.invoke('profiles:remove', { profileId })
  },
  bookmarks: {
    toggleActive: () => ipcRenderer.invoke('bookmarks:toggle-active'),
    open: (bookmarkId, newTab = false) => ipcRenderer.invoke('bookmarks:open', { bookmarkId, newTab }),
    remove: (bookmarkId) => ipcRenderer.invoke('bookmarks:remove', { bookmarkId })
  },
  downloads: {
    open: (downloadId) => ipcRenderer.invoke('downloads:open', { downloadId }),
    show: (downloadId) => ipcRenderer.invoke('downloads:show', { downloadId }),
    openFolder: () => ipcRenderer.invoke('downloads:open-folder')
  },
  settings: {
    update: (payload) => ipcRenderer.invoke('settings:update', payload)
  },
  ui: {
    setSidebarWidth: (width) => ipcRenderer.invoke('ui:set-sidebar-width', { width })
  }
};

contextBridge.exposeInMainWorld('nebula', deepFreeze(api));
