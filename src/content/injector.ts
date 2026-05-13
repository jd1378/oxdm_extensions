// Two overlay surfaces inside one Shadow-DOM host:
//
//   1. **Pin** — a tiny floating "Download" pill anchored next to a
//      detected download-ish anchor. One per detection. ✕ dismisses
//      that pin only. Repositioned on scroll / resize.
//
//   2. **Selection button** — appears below the user's active text
//      selection when that selection contains URLs.
//
// Host page CSS can't reach either widget (Shadow-DOM mode 'open',
// but no host selector reaches in).

import iconSrc from '/icon-32.png';
import type { CaptureRequest } from '@/src/shared/messages';

const HOST_ID = 'oxdm-overlay-host';
let hostEl: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let selectionButton: HTMLElement | null = null;
const pins = new Map<Element, HTMLElement>();

function ensureHost(): ShadowRoot {
  if (shadow) return shadow;
  hostEl = document.createElement('div');
  hostEl.id = HOST_ID;
  hostEl.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
  document.documentElement.appendChild(hostEl);
  shadow = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  return shadow;
}

const css = `
:host, * { box-sizing: border-box; }
.btn, .pin {
  position: absolute;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px 4px 6px;
  background: #1f2937;
  color: #f9fafb;
  font: 600 12px/1.1 system-ui, -apple-system, Segoe UI, sans-serif;
  border-radius: 999px;
  box-shadow: 0 4px 14px rgba(0,0,0,.45);
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.btn img, .pin img { width: 16px; height: 16px; display: block; border-radius: 50%; }
.btn:hover, .pin:hover { background: #2563eb; }
.x {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; margin-left: 2px;
  border-radius: 50%;
  background: rgba(255,255,255,.08);
  font-size: 11px; line-height: 1;
  color: rgba(255,255,255,.75);
}
.x:hover { background: rgba(255,255,255,.2); color: #fff; }
`;

/** Attach a pin next to `target`. Idempotent per element. */
export function attachPin(target: HTMLElement, url: string) {
  if (pins.has(target)) return;
  const root = ensureHost();
  const btn = document.createElement('div');
  btn.className = 'pin';
  btn.title = `Send to oxdm — ${url}`;
  btn.innerHTML = `<img alt="" /><span>Download</span><span class="x" title="hide">✕</span>`;
  (btn.querySelector('img') as HTMLImageElement).src = iconSrc;
  root.appendChild(btn);
  pins.set(target, btn);

  const reposition = () => {
    if (!document.contains(target)) {
      detach(target);
      return;
    }
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    btn.style.top = `${r.top + window.scrollY - 2}px`;
    btn.style.left = `${r.right + window.scrollX + 6}px`;
  };
  reposition();
  const ro = new ResizeObserver(reposition);
  ro.observe(target);
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);
  (btn as any).__ro = ro;
  (btn as any).__reposition = reposition;

  btn.addEventListener('click', (ev) => {
    const t = ev.target as Element | null;
    if (t && t.classList.contains('x')) {
      detach(target);
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    sendCapture(url, { interactive: true });
  });
}

function detach(target: Element) {
  const btn = pins.get(target);
  if (!btn) return;
  (btn as any).__ro?.disconnect?.();
  const rp = (btn as any).__reposition;
  if (rp) {
    window.removeEventListener('scroll', rp);
    window.removeEventListener('resize', rp);
  }
  btn.remove();
  pins.delete(target);
}

export function removeAllButtons() {
  for (const t of [...pins.keys()]) detach(t);
  removeSelectionButton();
  if (hostEl) {
    hostEl.remove();
    hostEl = null;
    shadow = null;
  }
}

export function showSelectionButton(sel: Selection, urls: string[]) {
  const root = ensureHost();
  removeSelectionButton();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const btn = document.createElement('div');
  btn.className = 'btn';
  btn.innerHTML = `<img alt="" /><span>Download Selected${urls.length > 1 ? ` (${urls.length})` : ''}</span><span class="x" title="dismiss">✕</span>`;
  (btn.querySelector('img') as HTMLImageElement).src = iconSrc;
  btn.style.top = `${rect.bottom + window.scrollY + 4}px`;
  btn.style.left = `${rect.left + window.scrollX}px`;
  btn.addEventListener('mousedown', (ev) => ev.preventDefault());
  btn.addEventListener('click', (ev) => {
    const t = ev.target as Element | null;
    if (t && t.classList.contains('x')) {
      removeSelectionButton();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (urls.length === 1) sendCapture(urls[0], { interactive: true });
    else sendBatch(urls);
    removeSelectionButton();
  });
  root.appendChild(btn);
  selectionButton = btn;
}

export function removeSelectionButton() {
  if (selectionButton) {
    selectionButton.remove();
    selectionButton = null;
  }
}

function sendCapture(url: string, opts: Partial<CaptureRequest>) {
  const req: CaptureRequest = {
    url,
    referrer: location.href,
    interactive: opts.interactive ?? true,
  };
  browser.runtime.sendMessage({ kind: 'capture', req });
}

function sendBatch(urls: string[]) {
  const items: CaptureRequest[] = urls.map((u) => ({
    url: u,
    referrer: location.href,
    interactive: false,
  }));
  browser.runtime.sendMessage({ kind: 'batch', items });
}
