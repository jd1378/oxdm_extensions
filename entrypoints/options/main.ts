import './style.css';
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

/**
 * Push the stored settings into the form controls. The markup itself is
 * static and lives in index.html, so this only ever sets values, never
 * rebuilds nodes. Safe to call repeatedly (Reset does).
 */
function syncForm() {
  set('transport', settings.transport);
  set('pairingCode', settings.pairingCode);
  (document.getElementById('injectButton') as HTMLInputElement).checked =
    settings.injectButton;
  (document.getElementById('interactive') as HTMLInputElement).checked =
    settings.interactive;
  syncPairingDisabled();
  syncRoutingVisibility();
  renderQueueOptions(null);
}

/**
 * Wire every listener exactly once. Previously the whole page was
 * rebuilt on each render, which re-bound everything and made Reset
 * stack a second connection poller.
 */
function bindOnce() {
  document
    .getElementById('transport')!
    .addEventListener('change', syncPairingDisabled);
  document
    .getElementById('interactive')!
    .addEventListener('change', syncRoutingVisibility);

  for (const a of app.querySelectorAll<HTMLAnchorElement>('.nav a')) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      showTab(a.dataset.tab!);
    });
  }

  document.getElementById('save')!.addEventListener('click', save);
  document.getElementById('reset')!.addEventListener('click', async () => {
    await setSettings(DEFAULTS);
    settings = await getSettings();
    syncForm();
    void loadQueues();
    flashSaved();
  });

  document.getElementById('logs-clear')!.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ kind: 'clear-logs' });
    renderLogs([]);
  });
}

function showTab(tab: string) {
  for (const el of app.querySelectorAll<HTMLElement>('.nav a')) {
    el.classList.toggle('active', el.dataset.tab === tab);
  }
  for (const el of app.querySelectorAll<HTMLElement>('.panel')) {
    el.classList.toggle('active', el.dataset.panel === tab);
  }
  history.replaceState(null, '', `#${tab}`);
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
  syncForm();
  bindOnce();

  // Deep link straight to a tab, e.g. options.html#logs.
  const fromHash = location.hash.replace('#', '');
  if (fromHash && app.querySelector(`.nav a[data-tab="${CSS.escape(fromHash)}"]`)) {
    showTab(fromHash);
  }

  void loadQueues();
  void refreshLogs();
  refreshConnection();
  setInterval(refreshConnection, 1500);

  // Live-update the log panel whenever a new entry is pushed by the
  // background. Cheap: only runs while the Options tab is open.
  onLogsChange((logs) => renderLogs(logs));
})();
