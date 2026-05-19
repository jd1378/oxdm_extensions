import './style.css';
import iconUrl from '/icon-48.png';
import {
  getSettings,
  setSettings,
  DEFAULTS,
  type Settings,
} from '@/src/shared/state';

const app = document.getElementById('app')!;
let settings: Settings;

function render() {
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <img alt="" />
          <span>oxdm</span>
        </div>
        <div class="section-label">Settings</div>
        <nav class="nav">
          <a class="active" data-tab="connection">Connection</a>
          <a data-tab="capture">Capture</a>
          <a data-tab="detection">Detection</a>
          <a data-tab="about">About</a>
        </nav>
      </aside>

      <main class="main">
        <section data-panel="connection" class="panel active">
          <h1 class="title">Connection</h1>
          <p class="subtitle">
            How the extension reaches your oxdm desktop app.
            <span class="transport-badge" style="margin-left:8px">
              <span class="dot" id="conn-dot"></span>
              <span id="conn-text">disconnected</span>
            </span>
          </p>

          <section class="card">
            <h2>Transport</h2>
            <p class="hint">Native skips the pairing code — host self-discovers from <span class="kbd">oxdm.db</span>.</p>
            <div class="field">
              <label for="transport">Mode</label>
              <select id="transport">
                <option value="auto">Auto — native first, fallback to WebSocket</option>
                <option value="native">Native messaging only</option>
                <option value="ws">WebSocket only</option>
              </select>
            </div>
            <div class="field" style="margin-top:var(--space-4)">
              <label for="pairingCode">Pairing code (WebSocket transport)</label>
              <input type="text" id="pairingCode" autocomplete="off" placeholder="oxdm1.…" />
              <div class="help">From <em>oxdm → Settings → Browser integration → Pairing code</em>. Bundles port + token.</div>
            </div>
          </section>

          <section class="card">
            <h2>Capture rules</h2>
            <p class="hint">
              File types, MIME filters, size threshold, and per-domain skips are set in
              <em>oxdm → Settings → Browser integration</em>. The extension fetches them on connect.
            </p>
          </section>
        </section>

        <section data-panel="capture" class="panel">
          <h1 class="title">Capture</h1>
          <p class="subtitle">How the extension scans pages for download links.</p>

          <section class="card">
            <h2>Scanning</h2>
            <div class="field">
              <label for="scanIntervalMs">Scan interval (ms)</label>
              <input type="number" id="scanIntervalMs" min="500" />
              <div class="help">How often the content script re-walks the DOM.</div>
            </div>
          </section>
        </section>

        <section data-panel="detection" class="panel">
          <h1 class="title">Detection</h1>
          <p class="subtitle">In-page affordances near download-ish links.</p>

          <section class="card">
            <h2>Pinned button</h2>
            <div class="toggle-row">
              <label for="injectButton">
                Show the oxdm pin next to download links
                <div class="help">Turn off to hide the inline button; the right-click menu still works.</div>
              </label>
              <input type="checkbox" id="injectButton" class="switch" />
            </div>
          </section>
        </section>

        <section data-panel="about" class="panel">
          <h1 class="title">About</h1>
          <p class="subtitle">oxdm browser extension — capture downloads and route them to the oxdm desktop app.</p>
          <section class="card">
            <h2>Project</h2>
            <p class="hint">
              Source: <a href="https://github.com/jd1378/oxdm_extensions" target="_blank">github.com/jd1378/oxdm_extensions</a>.
            </p>
          </section>
        </section>

        <div class="footer">
          <button class="btn primary" id="save">Save changes</button>
          <button class="btn" id="reset">Reset to defaults</button>
          <span class="saved" id="saved">Saved.</span>
        </div>
      </main>
    </div>
  `;

  (app.querySelector('.brand img') as HTMLImageElement).src = iconUrl;

  set('transport', settings.transport);
  set('pairingCode', settings.pairingCode);
  set('scanIntervalMs', settings.scanIntervalMs);
  (document.getElementById('injectButton') as HTMLInputElement).checked = settings.injectButton;

  for (const a of app.querySelectorAll<HTMLAnchorElement>('.nav a')) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const tab = a.dataset.tab!;
      app.querySelectorAll('.nav a').forEach((el) => el.classList.remove('active'));
      a.classList.add('active');
      app.querySelectorAll<HTMLElement>('.panel').forEach((el) => {
        el.classList.toggle('active', el.dataset.panel === tab);
      });
      history.replaceState(null, '', `#${tab}`);
    });
  }

  const fromHash = location.hash.replace('#', '');
  if (fromHash) {
    const a = app.querySelector<HTMLAnchorElement>(`.nav a[data-tab="${fromHash}"]`);
    a?.click();
  }

  document.getElementById('save')!.addEventListener('click', save);
  document.getElementById('reset')!.addEventListener('click', async () => {
    await setSettings(DEFAULTS);
    settings = await getSettings();
    render();
    flashSaved();
  });

  refreshConnection();
  setInterval(refreshConnection, 1500);
}

async function refreshConnection() {
  try {
    const r = (await browser.runtime.sendMessage({ kind: 'connection-status' })) as {
      state?: string;
    };
    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');
    if (!dot || !text) return;
    const s = r?.state ?? 'disconnected';
    text.textContent = s;
    dot.className = 'dot';
    if (s === 'authed') dot.classList.add('ok');
    else if (s === 'connecting') dot.classList.add('warn');
    else if (s === 'error') dot.classList.add('err');
  } catch {}
}

function set(id: string, v: string | number) {
  const el = document.getElementById(id) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement;
  el.value = String(v);
}
function get(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value;
}

async function save() {
  const transport = get('transport') as Settings['transport'];
  const patch: Partial<Settings> = {
    transport: ['auto', 'native', 'ws'].includes(transport) ? transport : 'auto',
    pairingCode: get('pairingCode').trim(),
    scanIntervalMs: Math.max(500, +get('scanIntervalMs') || DEFAULTS.scanIntervalMs),
    injectButton: (document.getElementById('injectButton') as HTMLInputElement).checked,
  };
  await setSettings(patch);
  flashSaved();
}

function flashSaved() {
  const el = document.getElementById('saved')!;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

(async () => {
  settings = await getSettings();
  render();
})();
