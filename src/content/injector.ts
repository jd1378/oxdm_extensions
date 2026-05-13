// Injects an oxdm action button next to download-ish elements, and a
// floating selection button. Everything in a single host with shadow DOM
// so host-page CSS can't reach it.

import iconSrc from '/icon-32-on.png';
import type { CaptureRequest } from '@/src/shared/messages';

const HOST_ID = 'oxdm-overlay-host';
let hostEl: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
const pinned: Map<Element, HTMLElement> = new Map();
let selectionButton: HTMLElement | null = null;

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
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 6px 3px 4px;
  background: #1f2937;
  color: #f9fafb;
  font: 600 11px/1.1 system-ui, -apple-system, Segoe UI, sans-serif;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.btn img, .pin img { width: 14px; height: 14px; display: block; }
.btn:hover, .pin:hover { background: #2563eb; }
.x {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; margin-left: 2px;
  border-radius: 3px;
  background: rgba(255,255,255,.1);
  font-size: 11px; line-height: 1;
}
.x:hover { background: rgba(255,255,255,.25); }
`;

export function attachButton(target: HTMLElement, url: string) {
  const root = ensureHost();
  const btn = document.createElement('div');
  btn.className = 'pin';
  btn.title = `Send to oxdm — ${url}`;
  btn.innerHTML = `<img alt="" /><span>oxdm</span><span class="x" title="hide">✕</span>`;
  (btn.querySelector('img') as HTMLImageElement).src = iconSrc;
  root.appendChild(btn);
  pinned.set(target, btn);

  const reposition = () => {
    if (!document.contains(target)) {
      detach(target);
      return;
    }
    const r = target.getBoundingClientRect();
    btn.style.top = `${r.top + window.scrollY - 2}px`;
    btn.style.left = `${r.right + window.scrollX + 4}px`;
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
    sendCapture(url, { interactive: false });
  });
}

function detach(target: Element) {
  const btn = pinned.get(target);
  if (!btn) return;
  (btn as any).__ro?.disconnect?.();
  const rp = (btn as any).__reposition;
  if (rp) {
    window.removeEventListener('scroll', rp);
    window.removeEventListener('resize', rp);
  }
  btn.remove();
  pinned.delete(target);
}

export function removeAllButtons() {
  for (const t of [...pinned.keys()]) detach(t);
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
  btn.innerHTML = `<img alt="" /><span>oxdm (${urls.length})</span>`;
  (btn.querySelector('img') as HTMLImageElement).src = iconSrc;
  btn.style.top = `${rect.bottom + window.scrollY + 4}px`;
  btn.style.left = `${rect.left + window.scrollX}px`;
  btn.addEventListener('mousedown', (ev) => ev.preventDefault());
  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (urls.length === 1) {
      sendCapture(urls[0], { interactive: true });
    } else {
      sendBatch(urls);
    }
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
    interactive: opts.interactive ?? false,
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
