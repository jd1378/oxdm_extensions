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

// Reports the connection only. Auto-capture has its own row, and
// conflating the two used to make a paused capture look like a broken
// link to oxdm.
function statusLine(): { text: string; cls: string } {
  switch (connState) {
    case 'connected':       return { text: 'connected',     cls: 'ok' };
    case 'connecting':      return { text: 'connecting…',   cls: 'warn' };
    case 'reconnecting':    return { text: 'reconnecting…', cls: 'warn' };
    case 'token-rejected':  return { text: 'token rejected', cls: 'err' };
    case 'error':           return { text: 'error',         cls: 'err' };
    default:                return { text: 'not connected', cls: 'err' };
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

    <div class="row" data-action="toggle-auto-capture">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2v14"/><path d="m6 12 6 6 6-6"/><path d="M4 22h16"/>
      </svg>
      <span class="label">Auto capture downloads</span>
      <button class="switch ${settings.autoCapture ? 'on' : ''}" aria-label="toggle"></button>
    </div>

    <div class="row" data-action="toggle-interactive">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="label">Show confirmation dialog</span>
      <button class="switch ${settings.interactive ? 'on' : ''}" aria-label="toggle"></button>
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
    case 'toggle-auto-capture':
      await setSettings({ autoCapture: !settings.autoCapture });
      break;
    case 'toggle-interactive':
      await setSettings({ interactive: !settings.interactive });
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
  let next = 'disconnected';
  try {
    const r = (await browser.runtime.sendMessage({
      kind: 'connection-status',
    })) as { state: string } | undefined;
    next = r?.state ?? 'disconnected';
  } catch {
    // Service worker is asleep (MV3) or unavailable. Treat as
    // disconnected; the next poll wakes it.
  }
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
