import './style.css';
import { getSettings, setSettings, onSettingsChange, type Settings } from '@/src/shared/state';

const app = document.getElementById('app')!;

let settings: Settings;
let connState = 'disconnected';

async function render() {
  app.innerHTML = '';
  const row1 = el('div', 'row');
  const title = el('div', 'title');
  title.textContent = 'oxdm';
  row1.appendChild(title);
  row1.appendChild(el('div', 'spacer'));
  const toggle = document.createElement('button');
  toggle.className = 'toggle' + (settings.enabled ? ' on' : '');
  toggle.title = settings.enabled ? 'Click to disable' : 'Click to enable';
  toggle.addEventListener('click', async () => {
    await setSettings({ enabled: !settings.enabled });
  });
  row1.appendChild(toggle);
  app.appendChild(row1);

  const row2 = el('div', 'row');
  const dot = el('span', 'dot');
  if (connState === 'authed') dot.classList.add('ok');
  else if (connState === 'connecting') dot.classList.add('warn');
  row2.appendChild(dot);
  const status = document.createElement('span');
  status.textContent = settings.enabled
    ? connState === 'authed' ? 'Connected to oxdm' : `oxdm: ${connState}`
    : 'Disabled';
  row2.appendChild(status);
  app.appendChild(row2);

  const muted = el('div', 'muted');
  muted.textContent = `Port ${settings.port}${settings.token ? '' : ' · token not set'}`;
  app.appendChild(muted);

  const opts = el('div', 'row');
  const link = document.createElement('button');
  link.className = 'btn-link';
  link.textContent = 'Options…';
  link.addEventListener('click', () => browser.runtime.openOptionsPage());
  opts.appendChild(link);
  app.appendChild(opts);
}

function el(tag: string, cls?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

async function refreshConnection() {
  const r = (await browser.runtime.sendMessage({ kind: 'connection-status' })) as { state: string } | undefined;
  connState = r?.state ?? 'disconnected';
  render();
}

(async () => {
  settings = await getSettings();
  await refreshConnection();
  render();
  onSettingsChange(async (s) => {
    settings = s;
    await refreshConnection();
  });
  // poll for connection while popup open
  const iv = setInterval(refreshConnection, 1500);
  window.addEventListener('unload', () => clearInterval(iv));
})();
