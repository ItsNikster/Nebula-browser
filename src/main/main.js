const { app, BrowserWindow, BrowserView, ipcMain, session, shell, protocol, net, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      allowServiceWorkers: false
    }
  }
]);

const APP_NAME = 'Nebula';
const APP_PROTOCOL = 'app';
const RENDERER_HOST = 'renderer';
const SHELL_URL = `${APP_PROTOCOL}://${RENDERER_HOST}/index.html`;
const HOME_URL = `${APP_PROTOCOL}://${RENDERER_HOST}/start.html`;
const SEARCH_URL = 'https://www.google.com/search?q=';
const LEGACY_HOME_URLS = new Set(['https://www.google.com/', 'https://start.duckduckgo.com/']);
const DEFAULT_ACCENT = '#4f6ef7';
const WINDOW_INSET = 16;
const SIDEBAR_RAIL_WIDTH = 72;
const CONTENT_GAP = 16;
const CHROME_HEIGHT = {
  compact: 82,
  roomy: 96
};
const PROFILE_COLORS = ['#e56a28', '#3f8cff', '#13a37f', '#d24f6a', '#8b5cf6', '#f59e0b'];
const MAX_BOOKMARKS = 60;
const MAX_DOWNLOADS = 40;
const MAX_HISTORY = 200;
const SAFE_EXTERNAL_PROTOCOLS = new Set(['mailto:', 'tel:']);
const DANGEROUS_DOWNLOAD_EXTENSIONS = new Set(['.appx', '.bat', '.cmd', '.com', '.cpl', '.exe', '.hta', '.iso', '.jar', '.js', '.jse', '.lnk', '.msi', '.msp', '.ps1', '.reg', '.scr', '.vbe', '.vbs', '.wsf']);

const runtime = {
  adblocker: null,
  adblockerPromise: null,
  adblockStatus: {
    available: false,
    enabled: false,
    label: 'Ad block pending',
    detail: 'Dependencies are not loaded yet.'
  },
  state: null,
  tabsByProfile: new Map(),
  activeTabs: new Map(),
  trackedDownloadPartitions: new Set(),
  securedSessions: new WeakSet(),
  protocolSessions: new WeakSet(),
  sidebarDrawerWidth: 0,
  window: null
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main process.', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main process.', reason);
});

function createDefaultProfiles() {
  const mainId = crypto.randomUUID();
  const workId = crypto.randomUUID();

  return {
    profiles: [
      { id: mainId, name: 'Main', color: PROFILE_COLORS[0], homeUrl: HOME_URL },
      { id: workId, name: 'Work', color: PROFILE_COLORS[1], homeUrl: HOME_URL }
    ],
    activeProfileId: mainId,
    bookmarks: [],
    downloads: [],
    history: [],
    settings: {
      accentColor: DEFAULT_ACCENT,
      adblockEnabled: true,
      compactMode: false,
      performanceMode: 'lean',
      riskyMode: false
    }
  };
}

function normalizeHomeUrl(homeUrl) {
  if (typeof homeUrl !== 'string' || !homeUrl.trim()) {
    return HOME_URL;
  }

  if (LEGACY_HOME_URLS.has(homeUrl)) {
    return HOME_URL;
  }

  if (homeUrl.startsWith('file:') || homeUrl.startsWith(`${APP_PROTOCOL}://`)) {
    return HOME_URL;
  }

  return homeUrl;
}

function createAppProtocolHandler() {
  return (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.host !== RENDERER_HOST) {
      return new Response('Not found.', { status: 404 });
    }

    const rendererRoot = path.resolve(app.getAppPath(), 'src', 'renderer');
    const relativePath = decodeURIComponent(requestUrl.pathname || '/').replace(/^\/+/, '') || 'index.html';
    const targetPath = path.resolve(rendererRoot, relativePath);
    const isInsideRendererRoot = targetPath === rendererRoot || targetPath.startsWith(`${rendererRoot}${path.sep}`);
    if (!isInsideRendererRoot || !fs.existsSync(targetPath)) {
      return new Response('Not found.', { status: 404 });
    }

    return net.fetch(pathToFileURL(targetPath).toString());
  };
}

function registerAppProtocolInSession(targetSession) {
  if (!targetSession || runtime.protocolSessions.has(targetSession)) {
    return targetSession;
  }

  runtime.protocolSessions.add(targetSession);
  targetSession.protocol.handle(APP_PROTOCOL, createAppProtocolHandler());
  return targetSession;
}

function isHomeUrl(url) {
  return String(url || '') === HOME_URL;
}

function isShellUrl(url) {
  return String(url || '') === SHELL_URL;
}

function isLocalHttpHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized.endsWith('.localhost');
}

function classifyNavigationTarget(targetUrl, { allowHome = true } = {}) {
  const raw = String(targetUrl || '').trim();
  if (!raw) {
    return { type: 'block' };
  }

  if (allowHome && isHomeUrl(raw)) {
    return { type: 'allow', url: HOME_URL };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') {
      return { type: 'allow', url: parsed.toString() };
    }

    if (parsed.protocol === 'http:') {
      if (isLocalHttpHost(parsed.hostname)) {
        return { type: 'allow', url: parsed.toString() };
      }

      parsed.protocol = 'https:';
      if (parsed.port === '80') {
        parsed.port = '';
      }
      return { type: 'redirect', url: parsed.toString() };
    }

    if (SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      return { type: 'external', url: parsed.toString() };
    }
  } catch {
    return { type: 'block' };
  }

  return { type: 'block' };
}

async function openExternalSafely(targetUrl) {
  if (runtime.state?.settings?.riskyMode) {
    return false;
  }

  const decision = classifyNavigationTarget(targetUrl, { allowHome: false });
  if (decision.type !== 'external') {
    return false;
  }

  await shell.openExternal(decision.url);
  return true;
}

function secureSession(targetSession) {
  if (!targetSession || runtime.securedSessions.has(targetSession)) {
    return targetSession;
  }

  runtime.securedSessions.add(targetSession);
  registerAppProtocolInSession(targetSession);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  if (typeof targetSession.setPermissionCheckHandler === 'function') {
    targetSession.setPermissionCheckHandler(() => false);
  }

  if (typeof targetSession.setDisplayMediaRequestHandler === 'function') {
    targetSession.setDisplayMediaRequestHandler((_request, callback) => {
      callback({});
    });
  }

  return targetSession;
}

function normalizeStoredUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const raw = value.trim();
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(raw)) {
    return `http://${raw}`;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw)) {
    return raw;
  }

  if (!raw.includes(' ') && raw.includes('.')) {
    return `https://${raw}`;
  }

  return '';
}

function isBookmarkableUrl(url) {
  return /^https?:/i.test(String(url || '')) && url !== HOME_URL;
}

function labelFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const first = host.split('.')[0] || host;
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    return 'Favorite';
  }
}

function sanitizeBookmarks(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set();
  const next = [];

  for (const item of raw) {
    const url = normalizeStoredUrl(item?.url);
    if (!isBookmarkableUrl(url) || seen.has(url)) {
      continue;
    }

    seen.add(url);
    next.push({
      id: typeof item?.id === 'string' ? item.id : crypto.randomUUID(),
      title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : labelFromUrl(url),
      url,
      createdAt: Number.isFinite(item?.createdAt) ? item.createdAt : Date.now()
    });

    if (next.length >= MAX_BOOKMARKS) {
      break;
    }
  }

  return next;
}

function sanitizeDownloads(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item) => item && typeof item.filename === 'string')
    .slice(0, MAX_DOWNLOADS)
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      profileId: typeof item.profileId === 'string' ? item.profileId : '',
      filename: item.filename,
      path: typeof item.path === 'string' ? item.path : '',
      url: typeof item.url === 'string' ? item.url : '',
      status: item.status === 'completed' || item.status === 'cancelled' || item.status === 'interrupted' ? item.status : 'interrupted',
      receivedBytes: Number.isFinite(item.receivedBytes) ? item.receivedBytes : 0,
      totalBytes: Number.isFinite(item.totalBytes) ? item.totalBytes : 0,
      startedAt: Number.isFinite(item.startedAt) ? item.startedAt : Date.now(),
      completedAt: Number.isFinite(item.completedAt) ? item.completedAt : null
    }));
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item) => item && typeof item.url === 'string')
    .slice(0, MAX_HISTORY)
    .map((item) => {
      const url = normalizeStoredUrl(item.url);
      return {
        id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
        profileId: typeof item.profileId === 'string' ? item.profileId : '',
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : labelFromUrl(url),
        url,
        visitedAt: Number.isFinite(item.visitedAt) ? item.visitedAt : Date.now()
      };
    })
    .filter((item) => /^https?:/i.test(item.url));
}

function sanitizeState(raw) {
  const defaults = createDefaultProfiles();
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const profiles = Array.isArray(incoming.profiles) && incoming.profiles.length
    ? incoming.profiles
        .filter((profile) => profile && typeof profile.id === 'string' && typeof profile.name === 'string')
        .map((profile, index) => ({
          id: profile.id,
          name: profile.name.trim() || `Profile ${index + 1}`,
          color: typeof profile.color === 'string' ? profile.color : PROFILE_COLORS[index % PROFILE_COLORS.length],
          homeUrl: normalizeHomeUrl(profile.homeUrl)
        }))
    : defaults.profiles;

  const activeProfileId = profiles.some((profile) => profile.id === incoming.activeProfileId)
    ? incoming.activeProfileId
    : profiles[0].id;

  return {
    profiles,
    activeProfileId,
    bookmarks: sanitizeBookmarks(incoming.bookmarks),
    downloads: sanitizeDownloads(incoming.downloads),
    history: sanitizeHistory(incoming.history),
    settings: {
      accentColor: typeof incoming.settings?.accentColor === 'string' ? incoming.settings.accentColor : DEFAULT_ACCENT,
      adblockEnabled: typeof incoming.settings?.adblockEnabled === 'boolean' ? incoming.settings.adblockEnabled : true,
      compactMode: typeof incoming.settings?.compactMode === 'boolean' ? incoming.settings.compactMode : false,
      performanceMode: incoming.settings?.performanceMode === 'balanced' ? 'balanced' : 'lean',
      riskyMode: typeof incoming.settings?.riskyMode === 'boolean' ? incoming.settings.riskyMode : false
    }
  };
}
function getStatePath() {
  return path.join(app.getPath('userData'), 'nebula-state.json');
}

function loadState() {
  try {
    const statePath = getStatePath();
    if (!fs.existsSync(statePath)) {
      return createDefaultProfiles();
    }

    return sanitizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch (error) {
    console.warn('Failed to load state, falling back to defaults.', error);
    return createDefaultProfiles();
  }
}

function persistState() {
  if (!runtime.state) {
    return;
  }

  fs.mkdirSync(path.dirname(getStatePath()), { recursive: true });
  fs.writeFileSync(getStatePath(), JSON.stringify(runtime.state, null, 2), 'utf8');
}

function getProfileTabs(profileId) {
  if (!runtime.tabsByProfile.has(profileId)) {
    runtime.tabsByProfile.set(profileId, []);
  }

  return runtime.tabsByProfile.get(profileId);
}

function getProfile(profileId) {
  return runtime.state.profiles.find((profile) => profile.id === profileId) || null;
}

function getActiveProfileId() {
  return runtime.state.activeProfileId;
}

function getActiveTab(profileId = getActiveProfileId()) {
  const activeTabId = runtime.activeTabs.get(profileId);
  return getProfileTabs(profileId).find((tab) => tab.id === activeTabId) || null;
}

function getChromeOffset() {
  const chromeHeight = runtime.state.settings.compactMode ? CHROME_HEIGHT.compact : CHROME_HEIGHT.roomy;
  return WINDOW_INSET + chromeHeight + CONTENT_GAP;
}

function getSidebarOffset() {
  return WINDOW_INSET + SIDEBAR_RAIL_WIDTH + runtime.sidebarDrawerWidth + CONTENT_GAP;
}

function profilePartition(profileId) {
  return `persist:nebula:${profileId}`;
}

function syncRendererState() {
  if (!runtime.window || runtime.window.isDestroyed()) {
    return;
  }

  const activeProfileId = getActiveProfileId();
  const tabs = getProfileTabs(activeProfileId).map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    isLoading: tab.isLoading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    hibernated: tab.hibernated
  }));

  runtime.window.webContents.send('state:update', {
    appName: APP_NAME,
    activeProfileId,
    activeTabId: runtime.activeTabs.get(activeProfileId) || null,
    profiles: runtime.state.profiles.map((profile) => ({
      ...profile,
      tabCount: getProfileTabs(profile.id).length
    })),
    bookmarks: runtime.state.bookmarks,
    downloads: [...runtime.state.downloads].sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0)),
    history: runtime.state.history
      .filter((entry) => entry.profileId === activeProfileId)
      .sort((left, right) => (right.visitedAt || 0) - (left.visitedAt || 0)),
    settings: runtime.state.settings,
    tabs,
    runtime: {
      adblock: runtime.adblockStatus
    }
  });
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();

  if (!raw) {
    return HOME_URL;
  }

  if (isHomeUrl(raw)) {
    return HOME_URL;
  }

  const normalizedCandidate = normalizeStoredUrl(raw);
  if (normalizedCandidate) {
    const decision = classifyNavigationTarget(normalizedCandidate);
    if (decision.type === 'allow' || decision.type === 'redirect') {
      return decision.url;
    }
  }

  return `${SEARCH_URL}${encodeURIComponent(raw)}`;
}

function isWebUrl(url) {
  return /^https?:/i.test(url);
}

function getSessionForProfile(profileId) {
  return secureSession(session.fromPartition(profilePartition(profileId), { cache: true }));
}

function focusAddressBar() {
  if (!runtime.window || runtime.window.isDestroyed()) {
    return;
  }

  runtime.window.webContents.send('ui:command', { type: 'focus-address' });
}

function assertTrustedIpc(event) {
  const senderUrl = event?.senderFrame?.url || '';
  if (!runtime.window || event.sender !== runtime.window.webContents || !isShellUrl(senderUrl)) {
    throw new Error('Blocked IPC from untrusted sender.');
  }
}

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    assertTrustedIpc(event);
    return handler(payload, event);
  });
}

function chooseProfileColor() {
  const used = new Set(runtime.state.profiles.map((profile) => profile.color));
  return PROFILE_COLORS.find((color) => !used.has(color)) || PROFILE_COLORS[runtime.state.profiles.length % PROFILE_COLORS.length];
}

function updateTabNavigationState(tab) {
  if (!tab.view || tab.view.webContents.isDestroyed()) {
    tab.canGoBack = false;
    tab.canGoForward = false;
    tab.isLoading = false;
    return;
  }

  tab.canGoBack = tab.view.webContents.navigationHistory.canGoBack();
  tab.canGoForward = tab.view.webContents.navigationHistory.canGoForward();
  tab.title = tab.view.webContents.getTitle() || tab.title || 'New tab';
  tab.url = tab.view.webContents.getURL() || tab.url || HOME_URL;
}

function getBookmarkSnapshotFromActiveTab() {
  const tab = getActiveTab();
  if (!tab) {
    return null;
  }

  updateTabNavigationState(tab);
  if (!isBookmarkableUrl(tab.url)) {
    return null;
  }

  return {
    title: (tab.title || labelFromUrl(tab.url)).trim(),
    url: tab.url
  };
}

function toggleBookmarkForActiveTab() {
  const snapshot = getBookmarkSnapshotFromActiveTab();
  if (!snapshot) {
    return { ok: false };
  }

  const existing = runtime.state.bookmarks.find((bookmark) => bookmark.url === snapshot.url);
  if (existing) {
    runtime.state.bookmarks = runtime.state.bookmarks.filter((bookmark) => bookmark.id !== existing.id);
    persistState();
    syncRendererState();
    return { ok: true, removed: true };
  }

  runtime.state.bookmarks = [
    {
      id: crypto.randomUUID(),
      title: snapshot.title,
      url: snapshot.url,
      createdAt: Date.now()
    },
    ...runtime.state.bookmarks.filter((bookmark) => bookmark.url !== snapshot.url)
  ].slice(0, MAX_BOOKMARKS);

  persistState();
  syncRendererState();
  return { ok: true, added: true };
}

async function openBookmark(bookmarkId, newTab = false) {
  const bookmark = runtime.state.bookmarks.find((item) => item.id === bookmarkId);
  if (!bookmark) {
    return false;
  }

  if (newTab) {
    await createTab(getActiveProfileId(), bookmark.url);
  } else {
    await navigateActiveTab(bookmark.url);
  }

  return true;
}

function removeBookmark(bookmarkId) {
  runtime.state.bookmarks = runtime.state.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
  persistState();
  syncRendererState();
  return true;
}

function recordHistoryVisit(profileId, title, url, sync = true) {
  const normalizedUrl = normalizeStoredUrl(url);
  if (!/^https?:/i.test(normalizedUrl)) {
    return false;
  }

  const entry = {
    id: crypto.randomUUID(),
    profileId,
    title: String(title || labelFromUrl(normalizedUrl)).trim() || labelFromUrl(normalizedUrl),
    url: normalizedUrl,
    visitedAt: Date.now()
  };

  runtime.state.history = [
    entry,
    ...runtime.state.history.filter((item) => !(item.profileId === profileId && item.url === normalizedUrl))
  ].slice(0, MAX_HISTORY);

  persistState();
  if (sync) {
    syncRendererState();
  }

  return true;
}

function isDangerousDownloadPath(filePath) {
  return DANGEROUS_DOWNLOAD_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

async function confirmOpeningDownloadedFile(download) {
  if (!download?.path || !isDangerousDownloadPath(download.path)) {
    return true;
  }

  const response = await dialog.showMessageBox(runtime.window || null, {
    type: 'warning',
    buttons: ['Cancel', 'Open Anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Potentially Unsafe Download',
    message: `Open "${download.filename}"?`,
    detail: 'This file type can run code on your computer. Only open it if you trust the source.'
  });

  return response.response === 1;
}

async function confirmDownloadStart(filename) {
  const dangerous = isDangerousDownloadPath(filename);
  const message = dangerous
    ? `Download "${filename}" in Risky Mode?`
    : `Allow download "${filename}" while Risky Mode is active?`;
  const detail = dangerous
    ? 'This file type can run code on your computer. Risky Mode blocks it by default unless you explicitly allow it.'
    : 'Risky Mode asks for confirmation before any download from untrusted pages.';

  const response = await dialog.showMessageBox(runtime.window || null, {
    type: dangerous ? 'warning' : 'question',
    buttons: ['Cancel', 'Allow Download'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Risky Mode Download Check',
    message,
    detail
  });

  return response.response === 1;
}

function ensureUniqueDownloadPath(directory, filename) {
  fs.mkdirSync(directory, { recursive: true });
  const parsed = path.parse(filename || 'download');
  const extension = parsed.ext || '.bin';
  const name = parsed.name || 'download';
  let candidate = path.join(directory, `${name}${extension}`);
  let counter = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${name} (${counter})${extension}`);
    counter += 1;
  }

  return candidate;
}

function findDownload(downloadId) {
  return runtime.state.downloads.find((item) => item.id === downloadId) || null;
}
async function ensureAdblocker() {
  if (!runtime.state.settings.adblockEnabled) {
    runtime.adblockStatus = {
      available: true,
      enabled: false,
      label: 'Ad block off',
      detail: 'Blocking is disabled in settings.'
    };
    return null;
  }

  if (runtime.adblocker) {
    return runtime.adblocker;
  }

  if (!runtime.adblockerPromise) {
    runtime.adblockerPromise = (async () => {
      try {
        const { ElectronBlocker, adsAndTrackingLists } = require('@ghostery/adblocker-electron');
        const fetch = require('cross-fetch');
        const engineCachePath = path.join(app.getPath('userData'), 'ghostery-engine.bin');

        runtime.adblockStatus = {
          available: true,
          enabled: true,
          label: 'Ad block loading',
          detail: 'Preparing compatible network rules.'
        };
        syncRendererState();

        const blocker = await ElectronBlocker.fromLists(
          fetch,
          adsAndTrackingLists,
          {
            loadCosmeticFilters: false,
            loadGenericCosmeticsFilters: false,
            loadExtendedSelectors: false,
            enableMutationObserver: false
          },
          {
            path: engineCachePath,
            read: (targetPath) => fs.promises.readFile(targetPath),
            write: async (targetPath, buffer) => {
              await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
              await fs.promises.writeFile(targetPath, buffer);
            }
          }
        );

        runtime.adblocker = blocker;
        runtime.adblockStatus = {
          available: true,
          enabled: true,
          label: 'Ad block active',
          detail: 'Ghostery network rules are active in compatible mode.'
        };
        syncRendererState();
        return blocker;
      } catch (error) {
        runtime.adblockStatus = {
          available: false,
          enabled: false,
          label: 'Ad block unavailable',
          detail: 'The blocker package did not initialize.'
        };
        console.warn('Adblocker initialization failed.', error);
        syncRendererState();
        return null;
      }
    })();
  }

  return runtime.adblockerPromise;
}

async function applyAdblockToProfile(profileId) {
  try {
    const blocker = await ensureAdblocker();
    if (!blocker) {
      return;
    }

    const targetSession = getSessionForProfile(profileId);
    if (runtime.state.settings.adblockEnabled) {
      blocker.enableBlockingInSession(targetSession);
    } else if (typeof blocker.disableBlockingInSession === 'function') {
      blocker.disableBlockingInSession(targetSession);
    }
  } catch (error) {
    runtime.adblockStatus = {
      available: false,
      enabled: false,
      label: 'Ad block fallback',
      detail: 'Compatible network blocking could not attach to this session.'
    };
    console.warn('Failed to attach adblocker to session.', error);
    syncRendererState();
  }
}

function wireDownloadTrackingForProfile(profileId) {
  const partition = profilePartition(profileId);
  if (runtime.trackedDownloadPartitions.has(partition)) {
    return;
  }

  runtime.trackedDownloadPartitions.add(partition);
  const targetSession = getSessionForProfile(profileId);

  targetSession.on('will-download', (_event, item) => {
    const savePath = ensureUniqueDownloadPath(app.getPath('downloads'), item.getFilename());
    const beginTracking = () => {
      item.setSavePath(savePath);

      const record = {
        id: crypto.randomUUID(),
        profileId,
        filename: path.basename(savePath),
        path: savePath,
        url: item.getURL(),
        status: 'progressing',
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        startedAt: Date.now(),
        completedAt: null
      };

      runtime.state.downloads = [record, ...runtime.state.downloads].slice(0, MAX_DOWNLOADS);
      persistState();
      syncRendererState();

      item.on('updated', (_updateEvent, stateName) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        if (stateName === 'interrupted') {
          record.status = 'interrupted';
        }
        syncRendererState();
      });

      item.once('done', (_doneEvent, stateName) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.status = stateName === 'completed' ? 'completed' : stateName === 'cancelled' ? 'cancelled' : 'interrupted';
        record.completedAt = Date.now();
        persistState();
        syncRendererState();
      });
    };

    if (!runtime.state.settings.riskyMode) {
      beginTracking();
      return;
    }

    item.pause();
    void (async () => {
      const allowed = await confirmDownloadStart(path.basename(savePath));
      if (!allowed) {
        item.cancel();
        return;
      }

      beginTracking();
      item.resume();
    })();
  });
}

function handleShortcutEvent(event, input) {
  if (input.type !== 'keyDown') {
    return;
  }

  const key = String(input.key || '').toLowerCase();
  if (input.control && /^[1-9]$/.test(key)) {
    event.preventDefault();
    const index = Number(key) - 1;
    const targetProfile = runtime.state.profiles[index];
    if (targetProfile) {
      void switchProfile(targetProfile.id);
    }
    return;
  }

  if (input.control && key === 't' && !input.shift && !input.alt) {
    event.preventDefault();
    void createTab(getActiveProfileId(), HOME_URL);
    return;
  }

  if (input.control && key === 'n' && !input.shift && !input.alt) {
    event.preventDefault();
    void createTab(getActiveProfileId(), HOME_URL);
    return;
  }

  if (input.control && input.alt && key === 'r') {
    event.preventDefault();
    void updateSettings({ riskyMode: !runtime.state.settings.riskyMode });
    return;
  }

  if (input.control && key === 'w') {
    event.preventDefault();
    void closeTab(getActiveTab()?.id);
    return;
  }

  if (input.control && key === 'l') {
    event.preventDefault();
    focusAddressBar();
    return;
  }

  if (input.alt && key === 'left') {
    event.preventDefault();
    void goBack();
    return;
  }

  if (input.alt && key === 'right') {
    event.preventDefault();
    void goForward();
  }
}

function detachView(view) {
  if (!runtime.window || !view) {
    return;
  }

  if (runtime.window.getBrowserViews().includes(view)) {
    runtime.window.removeBrowserView(view);
  }
}

function destroyTabView(tab) {
  if (!tab?.view) {
    return;
  }

  const view = tab.view;
  detachView(view);
  if (!view.webContents.isDestroyed()) {
    view.webContents.destroy();
  }

  tab.view = null;
  tab.hibernated = true;
  tab.canGoBack = false;
  tab.canGoForward = false;
  tab.isLoading = false;
}

async function recoverTabAfterFailure(tab, reason = 'renderer failure') {
  if (!tab) {
    return;
  }

  console.warn(`Recovering tab after ${reason}.`, { tabId: tab.id, url: tab.url });
  destroyTabView(tab);
  tab.title = tab.title || 'Recovered tab';
  tab.isLoading = false;

  if (tab.profileId === getActiveProfileId() && runtime.activeTabs.get(tab.profileId) === tab.id) {
    try {
      await attachActiveTab(tab.profileId);
    } catch (error) {
      console.warn('Failed to recover active tab.', error);
      syncRendererState();
    }
    return;
  }

  syncRendererState();
}

function createBrowserView(tab) {
  const view = new BrowserView({
    webPreferences: {
      partition: profilePartition(tab.profileId),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      autoplayPolicy: 'document-user-activation-required'
    }
  });

  const { webContents } = view;
  webContents.on('page-title-updated', (_event, title) => {
    tab.title = title || tab.title;
    syncRendererState();
  });
  webContents.on('did-start-loading', () => {
    tab.isLoading = true;
    syncRendererState();
  });
  webContents.on('did-stop-loading', () => {
    tab.isLoading = false;
    updateTabNavigationState(tab);
    recordHistoryVisit(tab.profileId, tab.title, tab.url, false);
    syncRendererState();
  });
  webContents.on('did-navigate', (_event, url) => {
    tab.url = url;
    updateTabNavigationState(tab);
    syncRendererState();
  });
  webContents.on('did-navigate-in-page', (_event, url) => {
    tab.url = url;
    updateTabNavigationState(tab);
    recordHistoryVisit(tab.profileId, tab.title, tab.url, false);
    syncRendererState();
  });
  webContents.on('will-navigate', (event, url) => {
    const decision = classifyNavigationTarget(url);
    if (decision.type === 'allow') {
      return;
    }

    event.preventDefault();
    if (decision.type === 'redirect') {
      void webContents.loadURL(decision.url);
    } else if (decision.type === 'external') {
      void openExternalSafely(decision.url);
    }
  });
  webContents.on('will-redirect', (event, url) => {
    const decision = classifyNavigationTarget(url);
    if (decision.type === 'allow') {
      return;
    }

    event.preventDefault();
    if (decision.type === 'redirect') {
      void webContents.loadURL(decision.url);
    } else if (decision.type === 'external') {
      void openExternalSafely(decision.url);
    }
  });
  webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) {
      return;
    }

    tab.title = 'Navigation error';
    tab.url = url || tab.url;
    tab.isLoading = false;
    syncRendererState();
    console.warn('Navigation failure:', description);
  });
  webContents.on('render-process-gone', (_event, details) => {
    void recoverTabAfterFailure(tab, details?.reason || 'render-process-gone');
  });
  webContents.on('unresponsive', () => {
    console.warn('Tab became unresponsive.', { tabId: tab.id, url: tab.url });
  });
  webContents.on('responsive', () => {
    syncRendererState();
  });
  webContents.setWindowOpenHandler(({ url }) => {
    const decision = classifyNavigationTarget(url, { allowHome: false });
    if (decision.type === 'allow' || decision.type === 'redirect') {
      void createTab(tab.profileId, decision.url);
    } else if (decision.type === 'external') {
      void openExternalSafely(decision.url);
    }
    return { action: 'deny' };
  });
  webContents.on('before-input-event', handleShortcutEvent);
  return view;
}

async function ensureTabView(tab) {
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    return tab.view;
  }

  wireDownloadTrackingForProfile(tab.profileId);
  await applyAdblockToProfile(tab.profileId);
  tab.view = createBrowserView(tab);
  tab.hibernated = false;
  tab.view.webContents.loadURL(tab.url || HOME_URL);
  return tab.view;
}

function layoutActiveView() {
  const activeTab = getActiveTab();
  if (!runtime.window || !activeTab?.view) {
    return;
  }

  const [width, height] = runtime.window.getContentSize();
  const x = getSidebarOffset();
  const y = getChromeOffset();
  activeTab.view.setBounds({
    x,
    y,
    width: Math.max(width - x - WINDOW_INSET, 0),
    height: Math.max(height - y - WINDOW_INSET, 0)
  });
  activeTab.view.setAutoResize({ width: true, height: true });
}

async function hibernateBackgroundTabs(profileId, keepTabId) {
  if (runtime.state.settings.performanceMode !== 'lean') {
    return;
  }

  for (const tab of getProfileTabs(profileId)) {
    if (tab.id !== keepTabId) {
      destroyTabView(tab);
    }
  }
}

async function attachActiveTab(profileId = getActiveProfileId()) {
  const activeTab = getActiveTab(profileId);
  if (!activeTab) {
    return;
  }

  for (const candidate of getProfileTabs(profileId)) {
    if (candidate.view && candidate.id !== activeTab.id) {
      detachView(candidate.view);
    }
  }

  const view = await ensureTabView(activeTab);
  detachView(view);
  runtime.window.addBrowserView(view);
  layoutActiveView();
  view.webContents.focus();

  if (runtime.state.settings.performanceMode === 'lean') {
    await hibernateBackgroundTabs(profileId, activeTab.id);
  }

  syncRendererState();
}
async function createTab(profileId, targetUrl = HOME_URL) {
  const profile = getProfile(profileId);
  if (!profile) {
    return null;
  }

  wireDownloadTrackingForProfile(profileId);

  const tab = {
    id: crypto.randomUUID(),
    profileId,
    title: 'New tab',
    url: normalizeUrl(targetUrl || profile.homeUrl || HOME_URL),
    isLoading: true,
    canGoBack: false,
    canGoForward: false,
    hibernated: false,
    view: null
  };

  getProfileTabs(profileId).push(tab);
  runtime.activeTabs.set(profileId, tab.id);

  if (profileId === getActiveProfileId()) {
    await attachActiveTab(profileId);
  } else if (runtime.state.settings.performanceMode !== 'lean') {
    await ensureTabView(tab);
  }

  syncRendererState();
  return tab;
}

async function switchTab(tabId) {
  if (!tabId) {
    return;
  }

  const profileId = getActiveProfileId();
  const target = getProfileTabs(profileId).find((tab) => tab.id === tabId);
  if (!target) {
    return;
  }

  runtime.activeTabs.set(profileId, tabId);
  await attachActiveTab(profileId);
}

async function closeTab(tabId) {
  if (!tabId) {
    return;
  }

  const profileId = getActiveProfileId();
  const tabs = getProfileTabs(profileId);
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return;
  }

  const [tab] = tabs.splice(index, 1);
  destroyTabView(tab);

  if (!tabs.length) {
    runtime.activeTabs.delete(profileId);
    await createTab(profileId, getProfile(profileId)?.homeUrl || HOME_URL);
    return;
  }

  const fallback = tabs[Math.max(index - 1, 0)];
  runtime.activeTabs.set(profileId, fallback.id);
  await attachActiveTab(profileId);
}

async function switchProfile(profileId) {
  if (!getProfile(profileId)) {
    return;
  }

  const currentProfileId = getActiveProfileId();
  const currentActive = getActiveTab(currentProfileId);
  if (currentActive?.view) {
    detachView(currentActive.view);
  }

  runtime.state.activeProfileId = profileId;
  persistState();

  if (!getProfileTabs(profileId).length) {
    await createTab(profileId, getProfile(profileId)?.homeUrl || HOME_URL);
    return;
  }

  if (!runtime.activeTabs.get(profileId)) {
    runtime.activeTabs.set(profileId, getProfileTabs(profileId)[0].id);
  }

  await attachActiveTab(profileId);
}

async function navigateActiveTab(input) {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }

  const targetUrl = normalizeUrl(input);
  tab.url = targetUrl;

  if (runtime.state.settings.performanceMode === 'lean') {
    await ensureTabView(tab);
    detachView(tab.view);
    runtime.window.addBrowserView(tab.view);
    layoutActiveView();
  }

  tab.view.webContents.loadURL(targetUrl);
  updateTabNavigationState(tab);
  syncRendererState();
}

async function goBack() {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }

  await ensureTabView(tab);
  if (tab.view.webContents.navigationHistory.canGoBack()) {
    tab.view.webContents.navigationHistory.goBack();
  }
}

async function goForward() {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }

  await ensureTabView(tab);
  if (tab.view.webContents.navigationHistory.canGoForward()) {
    tab.view.webContents.navigationHistory.goForward();
  }
}

async function reloadActiveTab(ignoreCache = false) {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }

  await ensureTabView(tab);
  if (ignoreCache) {
    tab.view.webContents.reloadIgnoringCache();
  } else {
    tab.view.webContents.reload();
  }
}

async function createProfile(name) {
  const normalizedName = String(name || '').trim().slice(0, 20);
  if (!normalizedName) {
    return null;
  }

  const profile = {
    id: crypto.randomUUID(),
    name: normalizedName,
    color: chooseProfileColor(),
    homeUrl: HOME_URL
  };

  runtime.state.profiles.push(profile);
  persistState();
  syncRendererState();
  await switchProfile(profile.id);
  return profile;
}

async function removeProfile(profileId) {
  const profileIndex = runtime.state.profiles.findIndex((profile) => profile.id === profileId);
  if (profileIndex === -1) {
    return { ok: false, reason: 'missing-profile' };
  }

  if (runtime.state.profiles.length <= 1) {
    return { ok: false, reason: 'last-profile' };
  }

  const wasActive = runtime.state.activeProfileId === profileId;
  const fallbackProfile = runtime.state.profiles.find((profile) => profile.id !== profileId) || null;
  const currentActive = getActiveTab(profileId);
  if (wasActive && currentActive?.view) {
    detachView(currentActive.view);
  }

  for (const tab of [...getProfileTabs(profileId)]) {
    destroyTabView(tab);
  }

  runtime.tabsByProfile.delete(profileId);
  runtime.activeTabs.delete(profileId);
  runtime.trackedDownloadPartitions.delete(profilePartition(profileId));
  runtime.state.profiles = runtime.state.profiles.filter((profile) => profile.id !== profileId);
  runtime.state.downloads = runtime.state.downloads.filter((download) => download.profileId !== profileId);
  runtime.state.history = runtime.state.history.filter((entry) => entry.profileId !== profileId);

  if (wasActive && fallbackProfile) {
    runtime.state.activeProfileId = fallbackProfile.id;
  }

  persistState();

  try {
    const targetSession = getSessionForProfile(profileId);
    await targetSession.clearStorageData();
    await targetSession.clearCache();
  } catch (error) {
    console.warn(`Failed to clear workspace session for ${profileId}.`, error);
  }

  if (wasActive && fallbackProfile) {
    if (!getProfileTabs(fallbackProfile.id).length) {
      await createTab(fallbackProfile.id, fallbackProfile.homeUrl || HOME_URL);
    } else {
      if (!runtime.activeTabs.get(fallbackProfile.id)) {
        runtime.activeTabs.set(fallbackProfile.id, getProfileTabs(fallbackProfile.id)[0].id);
      }

      await attachActiveTab(fallbackProfile.id);
    }
  } else {
    syncRendererState();
  }

  return { ok: true };
}

async function openDownload(downloadId) {
  const download = findDownload(downloadId);
  if (!download?.path || !fs.existsSync(download.path)) {
    return false;
  }

  if (!(await confirmOpeningDownloadedFile(download))) {
    return false;
  }

  await shell.openPath(download.path);
  return true;
}

async function showDownload(downloadId) {
  const download = findDownload(downloadId);
  if (!download?.path || !fs.existsSync(download.path)) {
    await shell.openPath(app.getPath('downloads'));
    return false;
  }

  shell.showItemInFolder(download.path);
  return true;
}

async function openDownloadsFolder() {
  await shell.openPath(app.getPath('downloads'));
  return true;
}

async function updateSettings(patch) {
  const next = {
    ...runtime.state.settings,
    ...patch
  };

  next.performanceMode = next.performanceMode === 'balanced' ? 'balanced' : 'lean';
  next.compactMode = Boolean(next.compactMode);
  next.adblockEnabled = Boolean(next.adblockEnabled);
  next.riskyMode = Boolean(next.riskyMode);
  next.accentColor = typeof next.accentColor === 'string' ? next.accentColor : DEFAULT_ACCENT;

  runtime.state.settings = next;
  persistState();

  if (next.adblockEnabled) {
    for (const profile of runtime.state.profiles) {
      await applyAdblockToProfile(profile.id);
    }
  } else if (runtime.adblocker && typeof runtime.adblocker.disableBlockingInSession === 'function') {
    for (const profile of runtime.state.profiles) {
      runtime.adblocker.disableBlockingInSession(getSessionForProfile(profile.id));
    }

    runtime.adblockStatus = {
      available: true,
      enabled: false,
      label: 'Ad block off',
      detail: 'Blocking is disabled in settings.'
    };
  } else {
    runtime.adblockStatus = {
      available: true,
      enabled: false,
      label: 'Ad block off',
      detail: 'Blocking is disabled in settings.'
    };
  }

  if (next.performanceMode === 'lean' || next.riskyMode) {
    await hibernateBackgroundTabs(getActiveProfileId(), getActiveTab()?.id);
  }

  layoutActiveView();
  syncRendererState();
}
function wireIpc() {
  handleTrustedIpc('state:get', async () => {
    syncRendererState();
    return { appName: APP_NAME };
  });

  handleTrustedIpc('browser:new-tab', async (payload) => {
    await createTab(getActiveProfileId(), payload?.url || HOME_URL);
  });

  handleTrustedIpc('browser:switch-tab', async (payload) => {
    await switchTab(payload?.tabId);
  });

  handleTrustedIpc('browser:close-tab', async (payload) => {
    await closeTab(payload?.tabId);
  });

  handleTrustedIpc('browser:navigate', async (payload) => {
    await navigateActiveTab(payload?.url || HOME_URL);
  });

  handleTrustedIpc('browser:back', async () => {
    await goBack();
  });

  handleTrustedIpc('browser:forward', async () => {
    await goForward();
  });

  handleTrustedIpc('browser:reload', async (payload) => {
    await reloadActiveTab(Boolean(payload?.ignoreCache));
  });

  handleTrustedIpc('profiles:create', async (payload) => {
    await createProfile(payload?.name || '');
  });

  handleTrustedIpc('profiles:switch', async (payload) => {
    await switchProfile(payload?.profileId);
  });

  handleTrustedIpc('profiles:remove', async (payload) => removeProfile(payload?.profileId));

  handleTrustedIpc('bookmarks:toggle-active', async () => toggleBookmarkForActiveTab());
  handleTrustedIpc('bookmarks:open', async (payload) => openBookmark(payload?.bookmarkId, Boolean(payload?.newTab)));
  handleTrustedIpc('bookmarks:remove', async (payload) => removeBookmark(payload?.bookmarkId));

  handleTrustedIpc('downloads:open', async (payload) => openDownload(payload?.downloadId));
  handleTrustedIpc('downloads:show', async (payload) => showDownload(payload?.downloadId));
  handleTrustedIpc('downloads:open-folder', async () => openDownloadsFolder());

  handleTrustedIpc('settings:update', async (payload) => {
    await updateSettings(payload || {});
  });

  handleTrustedIpc('ui:set-sidebar-width', async (payload) => {
    runtime.sidebarDrawerWidth = Math.max(0, Math.min(Number(payload?.width) || 0, 320));
    layoutActiveView();
    return runtime.sidebarDrawerWidth;
  });
}

async function createMainWindow() {
  runtime.window = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    autoHideMenuBar: true,
    backgroundColor: '#141618',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false
    }
  });

  runtime.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  runtime.window.webContents.on('will-navigate', (event, url) => {
    if (!isShellUrl(url)) {
      event.preventDefault();
    }
  });
  runtime.window.webContents.on('render-process-gone', () => {
    if (runtime.window && !runtime.window.isDestroyed()) {
      void runtime.window.loadURL(SHELL_URL).then(() => {
        void switchProfile(runtime.state.activeProfileId);
      });
    }
  });
  runtime.window.on('unresponsive', () => {
    console.warn('Shell window became unresponsive.');
  });
  runtime.window.webContents.on('before-input-event', handleShortcutEvent);
  runtime.window.on('resize', layoutActiveView);
  runtime.window.on('closed', () => {
    runtime.window = null;
  });

  await runtime.window.loadURL(SHELL_URL);
  await switchProfile(runtime.state.activeProfileId);
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }

  app.setName(APP_NAME);
  runtime.state = loadState();
  secureSession(session.defaultSession);
  app.on('second-instance', () => {
    if (!runtime.window || runtime.window.isDestroyed()) {
      return;
    }

    if (runtime.window.isMinimized()) {
      runtime.window.restore();
    }
    runtime.window.focus();
  });
  app.on('session-created', (createdSession) => {
    secureSession(createdSession);
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
  wireIpc();
  await createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    runtime.state = runtime.state || loadState();
    await createMainWindow();
  }
});
