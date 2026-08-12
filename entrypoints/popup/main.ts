import './style.css';
import {
  getSettings,
  setSettings,
  onSettingsChange,
  type Settings,
} from '@/src/shared/state';

// The markup is static and lives in index.html. This module binds the
// rows once and then only pushes state into existing nodes, so nothing
// here ever assigns markup.

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

/** Paint every switch from the current settings. */
function syncSwitches() {
  for (const el of app.querySelectorAll<HTMLElement>('.switch')) {
    const key = el.dataset.switch as keyof Settings | undefined;
    if (!key) continue;
    el.classList.toggle('on', settings[key] === true);
  }
}

function updateStatusBadge() {
  const badge = document.getElementById('status');
  const text = document.getElementById('status-text');
  if (!badge || !text) return;
  const line = statusLine();
  badge.className = `status ${line.cls}`;
  text.textContent = line.text;
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

(async () => {
  settings = await getSettings();
  syncSwitches();

  // Bound once: the rows are never rebuilt, so a settings change only
  // repaints the switches.
  for (const el of app.querySelectorAll<HTMLElement>('.row')) {
    el.addEventListener('click', () => onAction(el.dataset.action!));
  }

  refreshConn();
  onSettingsChange((s) => {
    settings = s;
    syncSwitches();
  });
  const iv = setInterval(refreshConn, 1500);
  window.addEventListener('unload', () => clearInterval(iv));
})();
