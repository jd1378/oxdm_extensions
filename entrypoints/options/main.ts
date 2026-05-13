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
          <a class="active" href="#connection">Connection</a>
          <a href="#capture">Capture</a>
          <a href="#detection">Detection</a>
          <a href="#about">About</a>
        </nav>
      </aside>

      <main class="main">
        <h1 class="title">Extension settings</h1>
        <p class="subtitle">
          Connect the browser to your oxdm desktop app. Captured links open
          in the Add Download dialog — never silently.
        </p>

        <section id="connection" class="card">
          <h2>Connection</h2>
          <p class="hint">
            <span class="transport-badge"><span class="dot" id="conn-dot"></span><span id="conn-text">disconnected</span></span>
          </p>
          <div class="row cols-2">
            <div class="field">
              <label for="transport">Transport</label>
              <select id="transport">
                <option value="auto">Auto — native first, fallback to WebSocket</option>
                <option value="native">Native messaging only</option>
                <option value="ws">WebSocket only</option>
              </select>
              <div class="help">Native skips the pairing code — host self-discovers from <span class="kbd">oxdm.db</span>.</div>
            </div>
            <div class="field">
              <label for="nativeHostName">Native host name</label>
              <input type="text" id="nativeHostName" />
              <div class="help">Must match the installed manifest's <span class="kbd">name</span> field.</div>
            </div>
          </div>

          <div class="field" style="margin-top:var(--space-4)">
            <label for="pairingCode">Pairing code (WebSocket transport)</label>
            <input type="text" id="pairingCode" autocomplete="off" placeholder="oxdm1.…" />
            <div class="help">
              Single string from <em>oxdm → Settings → Browser integration → Pairing code</em>.
              Bundles port + token. Native transport ignores this.
            </div>
          </div>
        </section>

        <section id="capture" class="card">
          <h2>Download interception</h2>
          <p class="hint">
            Browser downloads matching these filters bypass oxdm and stay
            with the browser.
          </p>
          <div class="row cols-2">
            <div class="field">
              <label for="minSize">Minimum size (bytes)</label>
              <input type="number" id="minSize" min="0" />
              <div class="help">0 disables the size threshold.</div>
            </div>
            <div class="field">
              <label for="scanIntervalMs">In-page scan interval (ms)</label>
              <input type="number" id="scanIntervalMs" min="500" />
              <div class="help">How often the content script re-walks the DOM.</div>
            </div>
          </div>

          <div class="field" style="margin-top:var(--space-4)">
            <label for="skipDomains">Skip domains</label>
            <textarea id="skipDomains" placeholder="one host per line, e.g.&#10;internal.example.com"></textarea>
          </div>
          <div class="row cols-2">
            <div class="field">
              <label for="skipExtensions">Skip file extensions</label>
              <input type="text" id="skipExtensions" placeholder="html, htm, php" />
              <div class="help">Comma-separated, no dot.</div>
            </div>
            <div class="field">
              <label for="skipMimePrefixes">Skip MIME prefixes</label>
              <input type="text" id="skipMimePrefixes" placeholder="text/html, application/xhtml" />
              <div class="help">Comma-separated.</div>
            </div>
          </div>
        </section>

        <section id="detection" class="card">
          <h2>In-page detection</h2>
          <div class="toggle-row">
            <label for="injectButton">
              Show the oxdm pin next to download links
              <div class="help">Disable to keep the page chrome-free; you can still right-click to send a link.</div>
            </label>
            <input type="checkbox" id="injectButton" class="switch" />
          </div>
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
  set('nativeHostName', settings.nativeHostName);
  set('pairingCode', settings.pairingCode);
  set('minSize', settings.minSize);
  set('scanIntervalMs', settings.scanIntervalMs);
  (document.getElementById('injectButton') as HTMLInputElement).checked = settings.injectButton;
  set('skipDomains', settings.skipDomains.join('\n'));
  set('skipExtensions', settings.skipExtensions.join(', '));
  set('skipMimePrefixes', settings.skipMimePrefixes.join(', '));

  for (const a of app.querySelectorAll<HTMLAnchorElement>('.nav a')) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      app.querySelectorAll('.nav a').forEach((el) => el.classList.remove('active'));
      a.classList.add('active');
      document.querySelector(a.getAttribute('href')!)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
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
    nativeHostName: get('nativeHostName').trim() || DEFAULTS.nativeHostName,
    pairingCode: get('pairingCode').trim(),
    minSize: Math.max(0, +get('minSize') || 0),
    scanIntervalMs: Math.max(500, +get('scanIntervalMs') || DEFAULTS.scanIntervalMs),
    injectButton: (document.getElementById('injectButton') as HTMLInputElement).checked,
    skipDomains: parseList(get('skipDomains'), /\s+/),
    skipExtensions: parseList(get('skipExtensions'), /,/).map((s) =>
      s.toLowerCase().replace(/^\./, ''),
    ),
    skipMimePrefixes: parseList(get('skipMimePrefixes'), /,/).map((s) => s.toLowerCase()),
  };
  await setSettings(patch);
  flashSaved();
}

function parseList(text: string, sep: RegExp): string[] {
  return text.split(sep).map((s) => s.trim()).filter(Boolean);
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
