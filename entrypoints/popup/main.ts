import './style.css';
import {
  getSettings,
  setSettings,
  onSettingsChange,
  type Settings,
} from '@/src/shared/state';
const iconUrl = browser.runtime.getURL('/icon-48.png');

const app = document.getElementById('app')!;

let settings: Settings;
let connState = 'disconnected';

function statusLine(): { text: string; cls: string } {
  if (!settings.enabled) return { text: 'disabled', cls: 'warn' };
  switch (connState) {
    case 'authed':     return { text: 'connected',    cls: 'ok' };
    case 'connecting': return { text: 'connecting…',  cls: 'warn' };
    case 'error':      return { text: 'error',        cls: 'err' };
    default:           return { text: 'not connected', cls: 'err' };
  }
}

function render() {
  const { text, cls } = statusLine();
  app.innerHTML = `
    <div class="header">
      <div class="logo"><img alt="" /></div>
      <div>
        <div class="brand">oxdm</div>
        <div class="status ${cls}"><span class="dot"></span><span>${text}</span></div>
      </div>
    </div>

    <div class="row" data-action="toggle-enabled">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2v14"/><path d="m6 12 6 6 6-6"/><path d="M4 22h16"/>
      </svg>
      <span class="label">Auto capture downloads</span>
      <button class="switch ${settings.enabled ? 'on' : ''}" aria-label="toggle"></button>
    </div>

    <div class="row" data-action="toggle-inject">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>
      </svg>
      <span class="label">Show pin on detected links</span>
      <button class="switch ${settings.injectButton ? 'on' : ''}" aria-label="toggle"></button>
    </div>

    <div class="row" data-action="open-options">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09A1.65 1.65 0 0 0 9 4.09V4a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V10a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      <span class="label">Open full settings</span>
    </div>
  `;

  (app.querySelector('.logo img') as HTMLImageElement).src = iconUrl;

  for (const el of app.querySelectorAll<HTMLElement>('.row')) {
    el.addEventListener('click', () => onAction(el.dataset.action!));
  }
}

async function onAction(action: string) {
  switch (action) {
    case 'toggle-enabled':
      await setSettings({ enabled: !settings.enabled });
      break;
    case 'toggle-inject':
      await setSettings({ injectButton: !settings.injectButton });
      break;
    case 'open-options':
      browser.runtime.openOptionsPage();
      window.close();
      break;
  }
}

async function refreshConn() {
  const r = (await browser.runtime.sendMessage({
    kind: 'connection-status',
  })) as { state: string } | undefined;
  const next = r?.state ?? 'disconnected';
  if (next === connState) return;
  connState = next;
  updateStatusBadge();
}

function updateStatusBadge() {
  const badge = app.querySelector<HTMLElement>('.status');
  if (!badge) return;
  const { text, cls } = statusLine();
  badge.className = `status ${cls}`;
  badge.lastElementChild!.textContent = text;
}

(async () => {
  settings = await getSettings();
  // First paint synchronous; status badge gets corrected in a tick.
  render();
  refreshConn();
  onSettingsChange((s) => {
    settings = s;
    render();
    refreshConn();
  });
  // Poll only the badge — don't tear down the DOM each tick.
  const iv = setInterval(refreshConn, 1500);
  window.addEventListener('unload', () => clearInterval(iv));
})();
