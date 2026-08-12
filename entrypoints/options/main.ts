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
import type { QueueSummary } from '@/src/shared/messages';

const app = document.getElementById('app')!;
let settings: Settings;
let connPoll: ReturnType<typeof setInterval> | null = null;

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
          <a data-tab="handoff">Handoff</a>
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
            <p class="hint">Native skips the pairing code; the host self-discovers from <span class="kbd">oxdm.db</span>.</p>
            <div class="field">
              <label for="transport">Mode</label>
              <select id="transport">
                <option value="auto">Auto (native first, fallback to WebSocket)</option>
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

        <section data-panel="handoff" class="panel">
          <h1 class="title">Handoff</h1>
          <p class="subtitle">What happens the moment a download reaches oxdm.</p>

          <section class="card">
            <h2>Add dialog</h2>
            <div class="toggle-row">
              <label for="interactive">
                Ask before downloading
                <div class="help">
                  oxdm opens its Add Download dialog, where you set the folder,
                  filename, category, queue and segments before it starts.
                  Turn this off to send jobs straight to a queue.
                </div>
              </label>
              <input type="checkbox" id="interactive" class="switch" />
            </div>
          </section>

          <section class="card" id="routing-card">
            <h2>Queue</h2>
            <p class="hint">
              Only used when the Add dialog is off. When it is on, you pick the
              queue there instead. Multi-link selections always go to oxdm's
              triage dialog, which has its own queue selector.
            </p>
            <div class="field">
              <label for="defaultQueue">Send to</label>
              <select id="defaultQueue"></select>
              <div class="help" id="queues-help">Queue list comes from oxdm; connect to load it.</div>
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
          <p class="subtitle">oxdm browser extension: captures downloads and routes them to the oxdm desktop app.</p>
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
  const interactiveEl = document.getElementById('interactive') as HTMLInputElement;
  interactiveEl.checked = settings.interactive;
  interactiveEl.addEventListener('change', syncRoutingVisibility);
  syncRoutingVisibility();
  renderQueueOptions(null);
  void loadQueues();

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
  // render() runs again on Reset — without clearing, each pass would
  // stack another poller on the same page.
  if (connPoll !== null) clearInterval(connPoll);
  connPoll = setInterval(refreshConnection, 1500);

  const logsClear = document.getElementById('logs-clear');
  logsClear?.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ kind: 'clear-logs' });
    renderLogs([]);
  });
  void refreshLogs();
}

/** The queue picker is inert while oxdm's Add dialog is doing the
 *  asking — grey it out rather than hide it, so the reason stays
 *  visible instead of the card vanishing. */
function syncRoutingVisibility() {
  const on = (document.getElementById('interactive') as HTMLInputElement)?.checked;
  const card = document.getElementById('routing-card');
  const sel = document.getElementById('defaultQueue') as HTMLSelectElement | null;
  if (sel) sel.disabled = !!on;
  if (card) card.classList.toggle('disabled', !!on);
}

/**
 * Paint the queue `<select>`. `queues === null` means we have no live
 * list (oxdm offline, or not asked yet) — keep showing the stored
 * choice so saving the page can't silently reset routing to Main.
 */
function renderQueueOptions(queues: QueueSummary[] | null) {
  const sel = document.getElementById('defaultQueue') as HTMLSelectElement | null;
  if (!sel) return;
  const list =
    queues ??
    (settings.defaultQueue
      ? [{ id: settings.defaultQueue, name: settings.defaultQueueName || 'saved queue' }]
      : []);
  // Built as DOM rather than markup: queue names come from oxdm, and
  // `textContent` cannot be talked into being markup the way an escaped
  // string concatenated into innerHTML can.
  const addOption = (value: string, label: string) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  sel.replaceChildren();
  // Sending no queue is not the same as sending Main: it lets oxdm
  // apply its own per-category queue rules, which fall back to Main.
  // Picking Main explicitly here would override those rules.
  addOption('', 'Let oxdm decide (category rules, else Main)');
  for (const q of list) addOption(q.id, q.name);
  sel.value = list.some((q) => q.id === settings.defaultQueue)
    ? settings.defaultQueue
    : '';
}

async function loadQueues() {
  const help = document.getElementById('queues-help');
  let queues: QueueSummary[] | null = null;
  try {
    const r = (await browser.runtime.sendMessage({ kind: 'list-queues' })) as {
      queues?: QueueSummary[] | null;
    };
    queues = r?.queues ?? null;
  } catch {
    queues = null;
  }
  if (!queues) {
    if (help) help.textContent = 'Could not reach oxdm; showing the saved choice.';
    return;
  }
  if (help) help.textContent = `${queues.length} queue(s) from oxdm.`;
  // A queue deleted in oxdm should not stay selectable here.
  if (settings.defaultQueue && !queues.some((q) => q.id === settings.defaultQueue)) {
    await setSettings({ defaultQueue: '', defaultQueueName: '' });
    settings = await getSettings();
  }
  renderQueueOptions(queues);
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

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function renderLogs(logs: LogEntry[]) {
  const list = document.getElementById('logs-list');
  if (!list) return;
  list.replaceChildren();
  if (!logs.length) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.textContent = 'No entries yet.';
    list.appendChild(empty);
    return;
  }
  // Log messages quote URLs and server-supplied rejection reasons, so
  // they are the one place page-controlled text reaches this page.
  // Built as DOM with `textContent`, which never parses markup.
  const frag = document.createDocumentFragment();
  // Newest first.
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    const row = document.createElement('div');
    // A property assignment, not markup: nothing here is parsed as HTML.
    row.className = `logs-row logs-${e.level}`;
    row.append(
      span('logs-ts', new Date(e.ts).toLocaleTimeString()),
      span('logs-src', e.source + (e.count && e.count > 1 ? ` ×${e.count}` : '')),
      span('logs-msg', e.message),
    );
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

let lastConnState = '';
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
    // The queue list is only obtainable while connected, so fetch it
    // on the edge into 'connected' rather than polling for it.
    if (s === 'connected' && lastConnState !== 'connected') void loadQueues();
    lastConnState = s;
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
  const queueSel = document.getElementById('defaultQueue') as HTMLSelectElement;
  const patch: Partial<Settings> = {
    transport: resolved,
    // Save = user-initiated. Any auto-pin from a previous session
    // no longer applies; explicit choices are remembered as such.
    transportPinnedByAuto: false,
    pairingCode: get('pairingCode').trim(),
    injectButton: (document.getElementById('injectButton') as HTMLInputElement).checked,
    interactive: (document.getElementById('interactive') as HTMLInputElement)
      .checked,
    defaultQueue: queueSel.value,
    defaultQueueName: queueSel.value
      ? (queueSel.selectedOptions[0]?.textContent ?? '').trim()
      : '',
  };
  settings = await setSettings(patch);
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
