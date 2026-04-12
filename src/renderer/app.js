const accentOptions = ['#4f6ef7', '#16a085', '#e57a44', '#8f6bf3', '#d1547d', '#3d8bfd'];
const START_PAGE_PATTERN = /\/start\.html(?:$|[?#])/i;
const HOME_PLACEHOLDER = 'Search Google or type a URL';
const DRAWER_WIDTH = 248;

const state = {
  appName: 'Nebula',
  activeProfileId: null,
  activeTabId: null,
  profiles: [],
  bookmarks: [],
  downloads: [],
  history: [],
  settings: {
    accentColor: accentOptions[0],
    adblockEnabled: true,
    compactMode: false,
    performanceMode: 'lean',
    riskyMode: false
  },
  tabs: [],
  runtime: {
    adblock: {
      label: 'Pending',
      detail: 'Checking blocker runtime.'
    }
  }
};

const uiState = {
  activePanel: null,
  creatingWorkspace: false
};

const elements = {
  chromeRoot: document.getElementById('chromeRoot'),
  sidebarDrawer: document.getElementById('sidebarDrawer'),
  favoritesPanel: document.getElementById('favoritesPanel'),
  workspacePanel: document.getElementById('workspacePanel'),
  downloadsPanel: document.getElementById('downloadsPanel'),
  historyPanel: document.getElementById('historyPanel'),
  settingsPanel: document.getElementById('settingsPanel'),
  profileRail: document.getElementById('profileRail'),
  favoritesList: document.getElementById('favoritesList'),
  downloadsList: document.getElementById('downloadsList'),
  historyList: document.getElementById('historyList'),
  favoriteCurrentButton: document.getElementById('favoriteCurrentButton'),
  openDownloadsFolderButton: document.getElementById('openDownloadsFolderButton'),
  newWorkspaceDrawerButton: document.getElementById('newWorkspaceDrawerButton'),
  tabStrip: document.getElementById('tabStrip'),
  addressForm: document.getElementById('addressForm'),
  addressInput: document.getElementById('addressInput'),
  backButton: document.getElementById('backButton'),
  forwardButton: document.getElementById('forwardButton'),
  reloadButton: document.getElementById('reloadButton'),
  newTabButton: document.getElementById('newTabButton'),
  homeButton: document.getElementById('homeButton'),
  favoritesToggleButton: document.getElementById('favoritesToggleButton'),
  workspaceToggleButton: document.getElementById('workspaceToggleButton'),
  performanceToggleButton: document.getElementById('performanceToggleButton'),
  downloadsToggleButton: document.getElementById('downloadsToggleButton'),
  historyToggleButton: document.getElementById('historyToggleButton'),
  riskyModeButton: document.getElementById('riskyModeButton'),
  focusAddressButton: document.getElementById('focusAddressButton'),
  newProfileButton: document.getElementById('newProfileButton'),
  settingsToggle: document.getElementById('settingsToggle'),
  accentRow: document.getElementById('accentRow'),
  adblockToggle: document.getElementById('adblockToggle'),
  compactToggle: document.getElementById('compactToggle'),
  tabCountPill: document.getElementById('tabCountPill'),
  workspaceCreateForm: document.getElementById('workspaceCreateForm'),
  workspaceCreateCancelButton: document.getElementById('workspaceCreateCancelButton'),
  profileNameInput: document.getElementById('profileNameInput')
};

function hexToRgba(hex, alpha) {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map((part) => part + part).join('')
    : normalized;
  const number = parseInt(value, 16);
  const red = (number >> 16) & 255;
  const green = (number >> 8) & 255;
  const blue = number & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function setAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(color, 0.18));
  document.documentElement.style.setProperty('--accent-strong', hexToRgba(color, 0.32));
}

function getInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function getActiveTabRecord() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function isStartPageUrl(url) {
  const value = String(url || '').replace(/\\/g, '/');
  return (value.startsWith('file:') || value.startsWith('app:')) && START_PAGE_PATTERN.test(value);
}

function isBookmarkableUrl(url) {
  return /^https?:/i.test(String(url || '')) && !isStartPageUrl(url);
}

function isCurrentTabBookmarked() {
  const activeTab = getActiveTabRecord();
  return Boolean(activeTab && state.bookmarks.some((bookmark) => bookmark.url === activeTab.url));
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** exponent);
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
}

function formatDownloadStatus(download) {
  if (download.status === 'completed') {
    return `Completed - ${formatBytes(download.totalBytes || download.receivedBytes)}`;
  }

  if (download.status === 'cancelled') {
    return 'Canceled';
  }

  if (download.status === 'interrupted') {
    return 'Interrupted';
  }

  if (download.totalBytes > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)));
    return `${percent}% - ${formatBytes(download.receivedBytes)} of ${formatBytes(download.totalBytes)}`;
  }

  return `Downloading - ${formatBytes(download.receivedBytes)}`;
}

function formatVisitedAt(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  const visitedAt = new Date(timestamp);
  const now = new Date();
  const sameDay = visitedAt.toDateString() === now.toDateString();
  const timeText = visitedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay
    ? timeText
    : `${visitedAt.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeText}`;
}

function focusAddressInput() {
  elements.addressInput.focus();
  elements.addressInput.select();
  renderDrawerState();
}

function syncAddressBar(activeTab) {
  const currentUrl = activeTab?.url || '';
  elements.addressInput.placeholder = HOME_PLACEHOLDER;

  if (document.activeElement === elements.addressInput) {
    return;
  }

  elements.addressInput.value = isStartPageUrl(currentUrl) ? '' : currentUrl;
}

function setDrawerWidth() {
  const width = uiState.activePanel ? DRAWER_WIDTH : 0;
  document.documentElement.style.setProperty('--drawer-width', `${width}px`);
  void window.nebula.ui.setSidebarWidth(width);
}

function togglePanel(panelName) {
  uiState.activePanel = uiState.activePanel === panelName ? null : panelName;
  if (uiState.activePanel !== 'workspaces') {
    uiState.creatingWorkspace = false;
  }
  renderDrawerState();
}

function closeDrawer() {
  if (!uiState.activePanel) {
    return;
  }

  uiState.activePanel = null;
  uiState.creatingWorkspace = false;
  renderDrawerState();
}

function openWorkspaceCreator() {
  uiState.activePanel = 'workspaces';
  uiState.creatingWorkspace = true;
  renderDrawerState();
  elements.profileNameInput.value = '';
  queueMicrotask(() => elements.profileNameInput.focus());
}

function closeWorkspaceCreator() {
  uiState.creatingWorkspace = false;
  elements.profileNameInput.value = '';
  renderDrawerState();
}

function renderProfiles() {
  elements.profileRail.innerHTML = '';

  if (!state.profiles.length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-empty';
    empty.innerHTML = '<p>No workspaces yet.</p>';
    elements.profileRail.appendChild(empty);
    return;
  }

  for (const profile of state.profiles) {
    const canDelete = state.profiles.length > 1;
    const row = document.createElement('div');
    row.className = 'drawer-card workspace-card';
    if (profile.id === state.activeProfileId) {
      row.classList.add('is-active');
    }

    const button = document.createElement('button');
    button.className = 'workspace-card-main';
    button.type = 'button';
    button.title = `Open ${profile.name}`;

    const avatar = document.createElement('span');
    avatar.className = 'workspace-avatar';
    avatar.style.background = profile.color;
    avatar.textContent = getInitial(profile.name);

    const copy = document.createElement('span');
    copy.className = 'drawer-card-copy';
    copy.innerHTML = `<strong>${profile.name}</strong><p>${profile.tabCount || 0} tab${profile.tabCount === 1 ? '' : 's'}</p>`;

    const badge = document.createElement('span');
    badge.className = 'workspace-badge';
    badge.textContent = String(profile.tabCount || 0);

    const actions = document.createElement('span');
    actions.className = 'drawer-card-actions';

    const removeButton = document.createElement('button');
    removeButton.className = 'drawer-card-action';
    removeButton.type = 'button';
    removeButton.textContent = 'X';
    removeButton.title = canDelete
      ? `Delete ${profile.name}`
      : 'You need at least one workspace';
    removeButton.disabled = !canDelete;
    removeButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!canDelete) {
        return;
      }

      const confirmed = window.confirm(`Delete workspace "${profile.name}"? Tabs and session data in this workspace will be removed.`);
      if (!confirmed) {
        return;
      }

      await window.nebula.profiles.remove(profile.id);
    });

    actions.append(badge, removeButton);
    button.append(avatar, copy);
    button.addEventListener('click', async () => {
      closeDrawer();
      await window.nebula.profiles.switch(profile.id);
    });

    row.append(button, actions);
    elements.profileRail.appendChild(row);
  }
}
function renderFavorites() {
  const activeTab = getActiveTabRecord();
  const canSaveCurrent = isBookmarkableUrl(activeTab?.url);
  const isSaved = isCurrentTabBookmarked();

  elements.favoriteCurrentButton.disabled = !canSaveCurrent;
  elements.favoriteCurrentButton.textContent = isSaved ? 'Remove Current' : 'Save Current';
  elements.favoritesList.innerHTML = '';

  if (!state.bookmarks.length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-empty';
    empty.innerHTML = '<p>No favorites yet. Save the current page here.</p>';
    elements.favoritesList.appendChild(empty);
    return;
  }

  for (const bookmark of state.bookmarks) {
    const row = document.createElement('button');
    row.className = 'drawer-card';
    if (activeTab?.url === bookmark.url) {
      row.classList.add('is-active');
    }

    row.type = 'button';

    const visual = document.createElement('span');
    visual.className = 'drawer-card-visual';
    visual.textContent = getInitial(bookmark.title || hostFromUrl(bookmark.url));

    const copy = document.createElement('span');
    copy.className = 'drawer-card-copy';
    copy.innerHTML = `<strong>${bookmark.title}</strong><p>${hostFromUrl(bookmark.url)}</p>`;

    const actions = document.createElement('span');
    actions.className = 'drawer-card-actions';

    const openButton = document.createElement('button');
    openButton.className = 'drawer-card-action';
    openButton.type = 'button';
    openButton.textContent = 'Go';
    openButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeDrawer();
      await window.nebula.bookmarks.open(bookmark.id, false);
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'drawer-card-action';
    removeButton.type = 'button';
    removeButton.textContent = 'X';
    removeButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.nebula.bookmarks.remove(bookmark.id);
    });

    actions.append(openButton, removeButton);
    row.append(visual, copy, actions);
    row.addEventListener('click', async () => {
      closeDrawer();
      await window.nebula.bookmarks.open(bookmark.id, false);
    });

    elements.favoritesList.appendChild(row);
  }
}

function renderDownloads() {
  elements.downloadsList.innerHTML = '';

  if (!state.downloads.length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-empty';
    empty.innerHTML = '<p>No downloads yet. Files you download will appear here.</p>';
    elements.downloadsList.appendChild(empty);
    return;
  }

  for (const download of state.downloads) {
    const row = document.createElement('div');
    row.className = 'drawer-card';

    const visual = document.createElement('span');
    visual.className = 'drawer-card-visual';
    visual.textContent = 'DL';

    const copy = document.createElement('span');
    copy.className = 'drawer-card-copy';
    copy.innerHTML = `<strong>${download.filename}</strong><p>${formatDownloadStatus(download)}</p>`;

    const actions = document.createElement('span');
    actions.className = 'drawer-card-actions';

    const openButton = document.createElement('button');
    openButton.className = 'drawer-card-action';
    openButton.type = 'button';
    openButton.textContent = 'Open';
    openButton.disabled = download.status !== 'completed';
    openButton.addEventListener('click', async () => {
      await window.nebula.downloads.open(download.id);
    });

    const showButton = document.createElement('button');
    showButton.className = 'drawer-card-action';
    showButton.type = 'button';
    showButton.textContent = 'Show';
    showButton.addEventListener('click', async () => {
      await window.nebula.downloads.show(download.id);
    });

    actions.append(openButton, showButton);
    row.append(visual, copy, actions);
    elements.downloadsList.appendChild(row);
  }
}

function renderHistory() {
  const activeTab = getActiveTabRecord();
  elements.historyList.innerHTML = '';

  if (!state.history.length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-empty';
    empty.innerHTML = '<p>No history yet. Pages you open will appear here.</p>';
    elements.historyList.appendChild(empty);
    return;
  }

  for (const entry of state.history) {
    const row = document.createElement('button');
    row.className = 'drawer-card';
    if (activeTab?.url === entry.url) {
      row.classList.add('is-active');
    }

    row.type = 'button';

    const visual = document.createElement('span');
    visual.className = 'drawer-card-visual';
    visual.textContent = getInitial(entry.title || hostFromUrl(entry.url));

    const copy = document.createElement('span');
    copy.className = 'drawer-card-copy';
    copy.innerHTML = `<strong>${entry.title}</strong><p>${hostFromUrl(entry.url)} • ${formatVisitedAt(entry.visitedAt)}</p>`;

    const actions = document.createElement('span');
    actions.className = 'drawer-card-actions';

    const openButton = document.createElement('button');
    openButton.className = 'drawer-card-action';
    openButton.type = 'button';
    openButton.textContent = 'Go';
    openButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeDrawer();
      await window.nebula.browser.navigate(entry.url);
    });

    actions.append(openButton);
    row.append(visual, copy, actions);
    row.addEventListener('click', async () => {
      closeDrawer();
      await window.nebula.browser.navigate(entry.url);
    });

    elements.historyList.appendChild(row);
  }
}

function renderTabs() {
  elements.tabStrip.innerHTML = '';

  for (const tab of state.tabs) {
    const button = document.createElement('button');
    button.className = 'tab-chip';
    if (tab.id === state.activeTabId) {
      button.classList.add('active');
    }

    button.type = 'button';

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.hibernated ? `${tab.title} sleeping` : tab.title;

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = 'x';

    button.append(title, close);

    button.addEventListener('click', async (event) => {
      if (event.target.closest('.close')) {
        event.stopPropagation();
        await window.nebula.browser.closeTab(tab.id);
        return;
      }

      await window.nebula.browser.switchTab(tab.id);
    });

    elements.tabStrip.appendChild(button);
  }

  const active = getActiveTabRecord();
  syncAddressBar(active);
  elements.backButton.disabled = !active?.canGoBack;
  elements.forwardButton.disabled = !active?.canGoForward;
  elements.tabCountPill.textContent = `${state.tabs.length} tab${state.tabs.length === 1 ? '' : 's'}`;
}

function renderSettings() {
  elements.chromeRoot.classList.toggle('compact', state.settings.compactMode);
  elements.adblockToggle.checked = state.settings.adblockEnabled;
  elements.compactToggle.checked = state.settings.compactMode;
  elements.performanceToggleButton.classList.toggle('active', state.settings.performanceMode === 'lean');
  elements.performanceToggleButton.title = state.settings.performanceMode === 'lean'
    ? 'Lean mode is active'
    : 'Balanced mode is active';
  elements.riskyModeButton.classList.toggle('active', state.settings.riskyMode);
  elements.riskyModeButton.title = state.settings.riskyMode
    ? 'Risky site mode is active (Ctrl+Alt+R)'
    : 'Risky site mode is off (Ctrl+Alt+R)';

  elements.accentRow.innerHTML = '';
  for (const color of accentOptions) {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    if (color === state.settings.accentColor) {
      swatch.classList.add('active');
    }

    swatch.type = 'button';
    swatch.style.background = color;
    swatch.addEventListener('click', () => {
      window.nebula.settings.update({ accentColor: color });
    });
    elements.accentRow.appendChild(swatch);
  }

  document.querySelectorAll('[data-performance]').forEach((button) => {
    button.classList.toggle('active', button.dataset.performance === state.settings.performanceMode);
  });

  setAccent(state.settings.accentColor);
}
function renderDrawerState() {
  const activePanel = uiState.activePanel;
  const activeTab = getActiveTabRecord();
  const savedCurrent = isCurrentTabBookmarked();
  const hasRunningDownloads = state.downloads.some((download) => download.status === 'progressing');

  elements.sidebarDrawer.classList.toggle('hidden', !activePanel);
  elements.favoritesPanel.classList.toggle('hidden', activePanel !== 'favorites');
  elements.workspacePanel.classList.toggle('hidden', activePanel !== 'workspaces');
  elements.downloadsPanel.classList.toggle('hidden', activePanel !== 'downloads');
  elements.historyPanel.classList.toggle('hidden', activePanel !== 'history');
  elements.settingsPanel.classList.toggle('hidden', activePanel !== 'settings');
  elements.workspaceCreateForm.classList.toggle('hidden', !(activePanel === 'workspaces' && uiState.creatingWorkspace));
  elements.newWorkspaceDrawerButton.textContent = uiState.creatingWorkspace ? 'Close' : 'New';

  elements.homeButton.classList.toggle('active', isStartPageUrl(activeTab?.url));
  elements.favoritesToggleButton.classList.toggle('active', activePanel === 'favorites' || savedCurrent);
  elements.workspaceToggleButton.classList.toggle('active', activePanel === 'workspaces');
  elements.downloadsToggleButton.classList.toggle('active', activePanel === 'downloads' || hasRunningDownloads);
  elements.historyToggleButton.classList.toggle('active', activePanel === 'history');
  elements.settingsToggle.classList.toggle('active', activePanel === 'settings');
  elements.focusAddressButton.classList.toggle('active', document.activeElement === elements.addressInput);
  elements.riskyModeButton.classList.toggle('active', state.settings.riskyMode);

  setDrawerWidth();
}

function renderAll() {
  renderProfiles();
  renderFavorites();
  renderDownloads();
  renderHistory();
  renderTabs();
  renderSettings();
  renderDrawerState();
}

elements.addressForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  closeDrawer();
  await window.nebula.browser.navigate(elements.addressInput.value);
});

elements.backButton.addEventListener('click', () => window.nebula.browser.back());
elements.forwardButton.addEventListener('click', () => window.nebula.browser.forward());
elements.reloadButton.addEventListener('click', () => window.nebula.browser.reload());
elements.newTabButton.addEventListener('click', () => window.nebula.browser.newTab());

elements.homeButton.addEventListener('click', async () => {
  closeDrawer();
  await window.nebula.browser.navigate('');
});

elements.favoritesToggleButton.addEventListener('click', () => {
  togglePanel('favorites');
});

elements.workspaceToggleButton.addEventListener('click', () => {
  togglePanel('workspaces');
});

elements.downloadsToggleButton.addEventListener('click', () => {
  togglePanel('downloads');
});

elements.historyToggleButton.addEventListener('click', () => {
  togglePanel('history');
});

elements.settingsToggle.addEventListener('click', () => {
  togglePanel('settings');
});

elements.performanceToggleButton.addEventListener('click', () => {
  const nextMode = state.settings.performanceMode === 'lean' ? 'balanced' : 'lean';
  window.nebula.settings.update({ performanceMode: nextMode });
});

elements.riskyModeButton.addEventListener('click', () => {
  window.nebula.settings.update({ riskyMode: !state.settings.riskyMode });
});

elements.focusAddressButton.addEventListener('click', () => {
  closeDrawer();
  focusAddressInput();
});

elements.favoriteCurrentButton.addEventListener('click', async () => {
  await window.nebula.bookmarks.toggleActive();
});

elements.openDownloadsFolderButton.addEventListener('click', () => {
  window.nebula.downloads.openFolder();
});

elements.newProfileButton.addEventListener('click', () => {
  openWorkspaceCreator();
});

elements.newWorkspaceDrawerButton.addEventListener('click', () => {
  if (uiState.creatingWorkspace) {
    closeWorkspaceCreator();
    return;
  }

  openWorkspaceCreator();
});

elements.workspaceCreateCancelButton.addEventListener('click', () => {
  closeWorkspaceCreator();
});

elements.workspaceCreateForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const name = elements.profileNameInput.value.trim();
  if (!name) {
    elements.profileNameInput.focus();
    return;
  }

  await window.nebula.profiles.create(name);
  uiState.activePanel = 'workspaces';
  uiState.creatingWorkspace = false;
  elements.profileNameInput.value = '';
  renderDrawerState();
});

elements.adblockToggle.addEventListener('change', (event) => {
  window.nebula.settings.update({ adblockEnabled: event.target.checked });
});

elements.compactToggle.addEventListener('change', (event) => {
  window.nebula.settings.update({ compactMode: event.target.checked });
});

document.querySelectorAll('[data-performance]').forEach((button) => {
  button.addEventListener('click', () => {
    window.nebula.settings.update({ performanceMode: button.dataset.performance });
  });
});
elements.addressInput.addEventListener('focus', renderDrawerState);
elements.addressInput.addEventListener('blur', () => queueMicrotask(renderDrawerState));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeDrawer();
  }
});

window.nebula.onState((payload) => {
  Object.assign(state, payload);
  renderAll();
});

window.nebula.onCommand((command) => {
  if (command.type === 'focus-address') {
    focusAddressInput();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    focusAddressInput();
  }
});

window.nebula.bootstrap().then(() => {
  renderAll();
});




