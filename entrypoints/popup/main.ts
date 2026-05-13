import './style.css';
import {
  getSettings,
  setSettings,
  onSettingsChange,
  type Settings,
} from '@/src/shared/state';
import iconUrl from '/icon-48.png';

const app = document.getElementById('app')!;

let settings: Settings;
let connState = 'disconnected';

function statusLine(): { text: string; cls: string } {
  if (!settings.enabled) return { text: 'Disabled', cls: 'warn' };
  switch (connState) {
    case 'authed':       return { text: 'Connected',   cls: 'ok' };
    case 'connecting':   return { text: 'Connecting…', cls: 'warn' };
    case 'error':        return { text: 'Error',       cls: 'bad' };
    default:             return { text: 'Not Connected', cls: 'bad' };
  }
}

function render() {
  const { text, cls } = statusLine();
  app.innerHTML = `
    <div class="header">
      <div class="logo"><img alt="" /></div>
      <div>
        <div class="title">oxdm Quick Settings</div>
        <div class="status ${cls}">${text}</div>
      </div>
    </div>

    <div class="row" data-action="toggle-enabled">
      <span class="label">Auto Capture Links</span>
      <span class="right">
        <button class="switch ${settings.enabled ? 'on' : ''}" aria-label="toggle"></button>
      </span>
    </div>

    <div class="row" data-action="toggle-inject">
      <span class="label">Show Popups</span>
      <span class="right">
        <button class="switch ${settings.injectButton ? 'on' : ''}" aria-label="toggle"></button>
      </span>
    </div>

    <div class="divider"></div>

    <div class="row" data-action="open-options">
      <span class="label">More Settings</span>
      <span class="right">
        <svg class="gear" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </span>
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
  connState = r?.state ?? 'disconnected';
  render();
}

(async () => {
  settings = await getSettings();
  await refreshConn();
  onSettingsChange(async (s) => {
    settings = s;
    await refreshConn();
  });
  const iv = setInterval(refreshConn, 1500);
  window.addEventListener('unload', () => clearInterval(iv));
})();
