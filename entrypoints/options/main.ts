import './style.css';
import iconUrl from '/icon-48.png';
import {
  getSettings,
  setSettings,
  DEFAULTS,
  type Settings,
} from '@/src/shared/state';
import {
  getLogs,
  onLogsChange,
  type LogEntry,
} from '@/src/shared/log';

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
          <a data-tab="detection">Detection</a>
          <a data-tab="logs">Logs</a>
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

        </section>

        <section data-panel="detection" class="panel">
          <h1 class="title">Detection</h1>
          <p class="subtitle">In-page affordances near download-ish links.</p>

          <section class="card">
            <h2>Capture rules</h2>
            <p class="hint">
              File types, MIME filters, size threshold, and per-domain skips are set in
              <em>oxdm → Settings → Browser integration</em>. The extension fetches them on connect.
            </p>
          </section>

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

        <section data-panel="logs" class="panel">
          <h1 class="title">Logs</h1>
          <p class="subtitle">
            Recent connection errors and capture rejections. Useful for
            diagnosing why the extension can't reach oxdm or why a
            download was refused. Capped at the most recent 100 entries.
          </p>
          <section class="card">
            <div class="logs-header">
              <h2>Recent entries</h2>
              <button class="btn btn-compact" id="logs-clear" type="button" title="Clear all log entries">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 6h18"/>
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  <path d="M10 11v6"/>
                  <path d="M14 11v6"/>
                </svg>
                <span>Clear</span>
              </button>
            </div>
            <div id="logs-list" class="logs"></div>
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
  syncPairingDisabled();
  const transportEl = document.getElementById('transport') as HTMLSelectElement;
  transportEl.addEventListener('change', syncPairingDisabled);
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

  const logsClear = document.getElementById('logs-clear');
  logsClear?.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ kind: 'clear-logs' });
    renderLogs([]);
  });
  void refreshLogs();
}

async function refreshLogs() {
  // Pull through the background so a single source of truth exists
  // even if storage-key conventions change later. Falls back to a
  // direct storage read if the SW is asleep.
  let logs: LogEntry[] = [];
  try {
    const r = (await browser.runtime.sendMessage({ kind: 'get-logs' })) as {
      logs?: LogEntry[];
    };
    logs = r?.logs ?? [];
  } catch {
    logs = await getLogs();
  }
  renderLogs(logs);
}

function renderLogs(logs: LogEntry[]) {
  const list = document.getElementById('logs-list');
  if (!list) return;
  if (!logs.length) {
    list.innerHTML = '<div class="logs-empty">No entries yet.</div>';
    return;
  }
  const rows: string[] = [];
  // Newest first.
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    const ts = new Date(e.ts).toLocaleTimeString();
    const cls = `logs-row logs-${e.level}`;
    const count = e.count && e.count > 1 ? ` ×${e.count}` : '';
    rows.push(
      `<div class="${cls}"><span class="logs-ts">${ts}</span>` +
        `<span class="logs-src">${escapeHtml(e.source)}${count}</span>` +
        `<span class="logs-msg">${escapeHtml(e.message)}</span></div>`,
    );
  }
  list.innerHTML = rows.join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    if (s === 'connected') dot.classList.add('ok');
    else if (s === 'connecting' || s === 'reconnecting') dot.classList.add('warn');
    else if (s === 'error' || s === 'token-rejected') dot.classList.add('err');
    if (s === 'token-rejected') text.textContent = 'token rejected';
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
  const resolved = ['auto', 'native', 'ws'].includes(transport)
    ? transport
    : 'auto';
  const patch: Partial<Settings> = {
    transport: resolved,
    // Save = user-initiated. Any auto-pin from a previous session
    // no longer applies; explicit choices are remembered as such.
    transportPinnedByAuto: false,
    pairingCode: get('pairingCode').trim(),
    injectButton: (document.getElementById('injectButton') as HTMLInputElement).checked,
  };
  await setSettings(patch);
  flashSaved();
}

function syncPairingDisabled() {
  const t = (document.getElementById('transport') as HTMLSelectElement)?.value;
  const input = document.getElementById('pairingCode') as HTMLInputElement | null;
  if (!input) return;
  // Only the direct WebSocket transport uses the pairing code; the
  // shim discovers port + token from oxdm.db, and 'auto' tries
  // native first. Keep the field active in 'ws' mode and disabled
  // otherwise so users don't think pasting a code here changes how
  // the other transports behave.
  const disabled = t !== 'ws';
  input.disabled = disabled;
  input.placeholder = disabled
    ? 'Only used with WebSocket transport'
    : 'oxdm1.…';
}

function flashSaved() {
  const el = document.getElementById('saved')!;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

(async () => {
  settings = await getSettings();
  render();
  // Live-update the log panel whenever a new entry is pushed by the
  // background. Cheap: render only runs while the Options tab is open.
  onLogsChange((logs) => renderLogs(logs));
})();
