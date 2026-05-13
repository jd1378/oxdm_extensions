// Mass-select dialog. Opened as a popup tab when content/background
// receives a multi-URL batch request. Per-row metadata streams in via
// background -> oxdm EvaluateUrl. User picks which to send and selects
// a target queue.

import type { CaptureRequest, QueueSummary } from '@/src/shared/messages';

interface Row {
  url: string;
  selected: boolean;
  filename?: string;
  size?: number;
  mime?: string;
  error?: string;
  evaluating: boolean;
}

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const incoming = (() => {
  try {
    return JSON.parse(decodeURIComponent(params.get('data') ?? '[]')) as CaptureRequest[];
  } catch {
    return [] as CaptureRequest[];
  }
})();

let rows: Row[] = incoming.map((c) => ({
  url: c.url,
  selected: true,
  evaluating: true,
}));
let queues: QueueSummary[] = [];
let selectedQueueId = '';

function render() {
  app.innerHTML = `
    <style>
      :root { color-scheme: light dark; }
      body { margin:0; font: 13px system-ui,-apple-system,Segoe UI,sans-serif; background: Canvas; color: CanvasText; }
      header { padding: 12px 16px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid GrayText; }
      header h1 { font-size: 15px; margin: 0; }
      header .spacer { flex: 1; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid color-mix(in oklab, GrayText 30%, transparent); vertical-align: top; }
      th { background: color-mix(in oklab, GrayText 10%, transparent); position: sticky; top: 0; }
      td.url { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
      td.size, td.mime, td.filename { white-space: nowrap; }
      footer { padding: 10px 16px; display: flex; gap: 10px; align-items: center; border-top: 1px solid GrayText; position: sticky; bottom: 0; background: Canvas; }
      button { padding: 6px 12px; border-radius: 6px; border: 1px solid GrayText; background: ButtonFace; color: ButtonText; cursor: pointer; }
      button.primary { background: #2563eb; border-color: transparent; color: white; }
      select { padding: 5px; }
      .spin::after { content: '…'; }
      .err { color: #dc2626; font-size: 11px; }
    </style>
    <header>
      <h1>Send to oxdm — ${rows.length} link${rows.length === 1 ? '' : 's'}</h1>
      <div class="spacer"></div>
      <label>Queue: <select id="queue"></select></label>
    </header>
    <table>
      <thead><tr>
        <th><input type="checkbox" id="all" /></th>
        <th>URL</th>
        <th class="filename">Filename</th>
        <th class="size">Size</th>
        <th class="mime">Type</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <footer>
      <span id="count"></span>
      <div style="flex:1"></div>
      <button id="cancel">Cancel</button>
      <button id="send" class="primary">Send to oxdm</button>
    </footer>
  `;

  const tb = document.getElementById('rows')!;
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-i="${i}" ${r.selected ? 'checked' : ''} /></td>
      <td class="url">${escape(r.url)}</td>
      <td class="filename">${r.evaluating ? '<span class="spin"></span>' : escape(r.filename ?? '—')}</td>
      <td class="size">${r.evaluating ? '' : (r.size != null ? fmtBytes(r.size) : '—')}</td>
      <td class="mime">${r.evaluating ? '' : escape(r.mime ?? '—')}${r.error ? `<div class="err">${escape(r.error)}</div>` : ''}</td>
    `;
    tb.appendChild(tr);
  });
  tb.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const i = +t.dataset.i!;
    rows[i].selected = t.checked;
    updateCount();
  });
  (document.getElementById('all') as HTMLInputElement).addEventListener('change', (ev) => {
    const v = (ev.target as HTMLInputElement).checked;
    rows = rows.map((r) => ({ ...r, selected: v }));
    render();
  });

  const sel = document.getElementById('queue') as HTMLSelectElement;
  for (const q of queues) {
    const o = document.createElement('option');
    o.value = q.id;
    o.textContent = q.name;
    sel.appendChild(o);
  }
  if (!queues.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(default)';
    sel.appendChild(o);
  }
  sel.value = selectedQueueId || queues[0]?.id || '';
  sel.addEventListener('change', () => (selectedQueueId = sel.value));

  document.getElementById('cancel')!.addEventListener('click', () => window.close());
  document.getElementById('send')!.addEventListener('click', send);
  updateCount();
}

function updateCount() {
  const n = rows.filter((r) => r.selected).length;
  const el = document.getElementById('count');
  if (el) el.textContent = `${n} selected`;
}

async function send() {
  const items: CaptureRequest[] = rows
    .filter((r) => r.selected)
    .map((r) => ({
      url: r.url,
      filename: r.filename,
      size: r.size,
      mime_type: r.mime,
      headers: selectedQueueId ? { 'X-Oxdm-Queue': selectedQueueId } : undefined,
      interactive: false,
    }));
  await browser.runtime.sendMessage({ kind: 'batch-send', items });
  window.close();
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

async function evaluateAll() {
  await Promise.all(
    rows.map(async (r, i) => {
      const res = (await browser.runtime.sendMessage({
        kind: 'evaluate',
        url: r.url,
      })) as any;
      rows[i] = {
        ...r,
        evaluating: false,
        filename: res?.filename,
        size: res?.size,
        mime: res?.mime_type,
        error: res?.error,
      };
      render();
    }),
  );
}

(async () => {
  queues = ((await browser.runtime.sendMessage({ kind: 'list-queues' })) as QueueSummary[]) ?? [];
  render();
  evaluateAll();
})();
