const STORAGE_KEY = 'nebula.start.shortcuts.v1';
const MAX_SHORTCUTS = 24;

const elements = {
  dialGrid: document.getElementById('dialGrid'),
  shortcutDialog: document.getElementById('shortcutDialog'),
  shortcutForm: document.getElementById('shortcutForm'),
  shortcutCancelButton: document.getElementById('shortcutCancelButton'),
  shortcutUrlInput: document.getElementById('shortcutUrlInput'),
  shortcutNameInput: document.getElementById('shortcutNameInput'),
  shortcutCardTemplate: document.getElementById('shortcutCardTemplate')
};

function readShortcuts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item.url === 'string')
      .slice(0, MAX_SHORTCUTS)
      .map((item) => {
        const url = normalizeWebsite(item.url);
        return {
          id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
          url,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : labelFromUrl(url)
        };
      })
      .filter((item) => item.url);
  } catch {
    return [];
  }
}

function saveShortcuts(shortcuts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts.slice(0, MAX_SHORTCUTS)));
}

function normalizeWebsite(input) {
  const value = String(input || '').trim();
  if (!value) {
    return '';
  }

  const withProtocol = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(value)
    ? `http://${value}`
    : /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)
      ? value
      : `https://${value}`;

  try {
    const url = new URL(withProtocol);
    if (!/^https?:$/.test(url.protocol)) {
      return '';
    }
    if (url.protocol === 'http:' && !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)) {
      url.protocol = 'https:';
      if (url.port === '80') {
        url.port = '';
      }
    }
    return url.toString();
  } catch {
    return '';
  }
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function labelFromUrl(value) {
  const host = hostFromUrl(value);
  const first = host.split('.')[0] || host;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function faviconUrl(value) {
  return `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(value)}`;
}

function renderShortcuts() {
  const shortcuts = readShortcuts();
  elements.dialGrid.innerHTML = '';

  for (const shortcut of shortcuts) {
    const fragment = elements.shortcutCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.custom-shortcut');
    const removeButton = fragment.querySelector('.shortcut-remove');
    const logo = fragment.querySelector('.shortcut-logo');
    const fallback = fragment.querySelector('.shortcut-fallback');
    const title = fragment.querySelector('.dial-title');
    const host = fragment.querySelector('.dial-host');

    card.href = shortcut.url;
    title.textContent = shortcut.name;
    host.textContent = hostFromUrl(shortcut.url);
    logo.src = faviconUrl(shortcut.url);
    logo.alt = `${shortcut.name} logo`;
    logo.referrerPolicy = 'no-referrer';
    fallback.textContent = shortcut.name.charAt(0).toUpperCase();

    logo.addEventListener('error', () => {
      logo.classList.add('is-hidden');
      fallback.classList.add('is-visible');
    }, { once: true });

    removeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = readShortcuts().filter((item) => item.id !== shortcut.id);
      saveShortcuts(next);
      renderShortcuts();
    });

    elements.dialGrid.appendChild(fragment);
  }

  const addButton = document.createElement('button');
  addButton.className = 'dial-card dial-add';
  addButton.type = 'button';
  addButton.setAttribute('aria-label', 'Add shortcut');
  addButton.textContent = '+';
  addButton.addEventListener('click', openShortcutDialog);
  elements.dialGrid.appendChild(addButton);
}

function openShortcutDialog() {
  elements.shortcutUrlInput.value = '';
  elements.shortcutNameInput.value = '';
  elements.shortcutDialog.showModal();
  queueMicrotask(() => elements.shortcutUrlInput.focus());
}

function handleShortcutSubmit(event) {
  event.preventDefault();

  const url = normalizeWebsite(elements.shortcutUrlInput.value);
  if (!url) {
    elements.shortcutUrlInput.focus();
    return;
  }

  const name = elements.shortcutNameInput.value.trim() || labelFromUrl(url);
  const shortcuts = readShortcuts();
  shortcuts.push({
    id: crypto.randomUUID(),
    url,
    name
  });
  saveShortcuts(shortcuts);
  elements.shortcutDialog.close();
  renderShortcuts();
}

elements.shortcutCancelButton.addEventListener('click', () => {
  elements.shortcutDialog.close();
});

elements.shortcutForm.addEventListener('submit', handleShortcutSubmit);
renderShortcuts();
