// Two overlay surfaces inside one Shadow-DOM host:
//
//   1. **Pin** — one floating "Download" pill that only materializes
//      when the cursor is over (or just left) a detected anchor.
//      Positioned next to that anchor, never crowds the page.
//
//   2. **Selection button** — appears near the cursor when the user
//      selects text that contains URLs. Stays until ✕ is clicked or
//      the user's selection has been collapsed for 3 s.
//
// Host page CSS can't reach either widget (Shadow-DOM mode 'open'
// but page selectors can't enter).

// Resolve at runtime via the extension's own origin. A bare
// `import iconSrc from '/icon-32.png'` becomes the string `/icon-32.png`
// in the bundle, which the host page then tries to load from *its*
// origin — yielding 404s on every site that isn't ours.
const iconSrc = browser.runtime.getURL('/icon-32.png');
import type { CaptureRequest } from '@/src/shared/messages';

const HOST_ID = 'oxdm-overlay-host';
const HIDE_DELAY_MS = 150; // small grace so the cursor can travel from anchor → pin
const SELECTION_GRACE_MS = 500;

let hostEl: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let selectionButton: HTMLElement | null = null;
let selectionGraceTimer: ReturnType<typeof setTimeout> | null = null;
let pinButton: HTMLElement | null = null;
let pinTarget: HTMLAnchorElement | null = null;
let pinHideTimer: ReturnType<typeof setTimeout> | null = null;

// Tracked globally so registerDetected() can probe the element under
// the cursor immediately, and the selection button can spawn next to
// the most recent cursor position.
const lastMousePos = { x: NaN as number, y: NaN as number };
document.addEventListener(
  'mousemove',
  (e) => {
    lastMousePos.x = e.clientX;
    lastMousePos.y = e.clientY;
  },
  { passive: true, capture: true },
);

function ensureHost(): ShadowRoot {
  if (shadow) return shadow;
  hostEl = document.createElement('div');
  hostEl.id = HOST_ID;
  // Absolute (not fixed) so child page coordinates can use the
  // document's coordinate system directly. The translate3d hack
  // promotes the host to its own compositor layer so heavy host
  // pages can't reflow over the pin. z-index 9_999_999 keeps it
  // above the vast majority of stacking contexts in the wild.
  hostEl.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    'width:0',
    'height:0',
    'pointer-events:none',
    'transform:translate3d(0,0,0)',
    'z-index:2147483647',
  ].join(';');
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
  direction: ltr; /* keep icon ← text order even on RTL pages */
  display: inline-flex; align-items: stretch;
  background: #1f2937;
  color: #f9fafb;
  font: 600 14px/1.1 system-ui, -apple-system, Segoe UI, sans-serif;
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0,0,0,.5);
  pointer-events: auto;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.btn .body, .pin .body {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 10px 16px 10px 12px;
  cursor: pointer;
}
.btn .body, .pin .body { transition: background-color .12s ease; }
.btn .body:hover, .pin .body:hover { background: #2563eb; }
.btn img, .pin img { width: 22px; height: 22px; display: block; border-radius: 50%; }
.x {
  display: inline-flex; align-items: center; justify-content: center;
  width: 38px;
  padding: 0;
  background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.85);
  cursor: pointer;
  font: 700 18px/1 system-ui, sans-serif;
  transition: background-color .12s ease, color .12s ease;
}
.x:hover, .x:focus { background: #dc2626; color: #fff; }
.x:active { background: #b91c1c; }
`;

// ─── Pin (hover-anchored) ─────────────────────────────────────────

const detectedAnchors = new Set<HTMLAnchorElement>();
// ✕ on the pin permanently dismisses that anchor until the page is
// reloaded (the content script reloads with it, clearing the set).
const dismissedAnchors = new WeakSet<HTMLAnchorElement>();

/** Called by the scanner whenever an anchor passes download heuristics.
 *  If the cursor is currently sitting on that anchor, the pin shows
 *  immediately — otherwise the hover listener will fire on the next
 *  cursor move. */
export function registerDetected(anchor: HTMLAnchorElement) {
  detectedAnchors.add(anchor);
  if (cursorIsOver(anchor)) showPin(anchor);
}

function cursorIsOver(anchor: HTMLAnchorElement): boolean {
  if (dismissedAnchors.has(anchor)) return false;
  if (!Number.isFinite(lastMousePos.x)) return false;
  const el = document.elementFromPoint(lastMousePos.x, lastMousePos.y);
  if (!el) return false;
  return anchor === el || anchor.contains(el);
}

export function clearDetected() {
  detectedAnchors.clear();
  hidePinNow();
}

export function startPinHoverTracking() {
  document.addEventListener('mouseover', onDocMouseOver, { passive: true });
  document.addEventListener('mouseout', onDocMouseOut, { passive: true });
}

export function stopPinHoverTracking() {
  document.removeEventListener('mouseover', onDocMouseOver);
  document.removeEventListener('mouseout', onDocMouseOut);
  hidePinNow();
}

function onDocMouseOver(ev: MouseEvent) {
  const t = ev.target as Element | null;
  if (!t) return;
  const anchor = t.closest<HTMLAnchorElement>('a[href]');
  if (anchor && detectedAnchors.has(anchor) && !dismissedAnchors.has(anchor)) {
    showPin(anchor);
  }
}

function onDocMouseOut(ev: MouseEvent) {
  const relatedTarget = ev.relatedTarget as Element | null;
  // Cursor leaving the anchor → schedule hide. If it lands on the pin
  // body, pin's own listener cancels the timer.
  if (!pinTarget) return;
  if (
    relatedTarget &&
    (pinTarget.contains(relatedTarget) || pinButton?.contains(relatedTarget))
  )
    return;
  scheduleHidePin();
}

function showPin(anchor: HTMLAnchorElement) {
  if (pinHideTimer) {
    clearTimeout(pinHideTimer);
    pinHideTimer = null;
  }
  const root = ensureHost();
  if (pinTarget === anchor && pinButton) {
    repositionPin();
    return;
  }
  // Different anchor → rebuild
  if (pinButton) pinButton.remove();
  const btn = document.createElement('div');
  btn.className = 'pin';
  btn.innerHTML = `
    <span class="body"><img alt="" /><span>Download</span></span>
    <span class="x" title="hide">✕</span>
  `;
  (btn.querySelector('img') as HTMLImageElement).src = iconSrc;
  btn.title = `Send to oxdm — ${anchor.href}`;

  btn.addEventListener('mouseenter', () => {
    if (pinHideTimer) {
      clearTimeout(pinHideTimer);
      pinHideTimer = null;
    }
  });
  btn.addEventListener('mouseleave', () => scheduleHidePin());

  btn.querySelector('.x')!.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // ✕: permanent dismiss for this anchor until the page reloads.
    if (pinTarget) dismissedAnchors.add(pinTarget);
    hidePinNow();
  });
  btn.querySelector('.body')!.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    sendCapture(anchor.href, { interactive: true });
    hidePinNow();
  });

  root.appendChild(btn);
  pinButton = btn;
  pinTarget = anchor;
  repositionPin();

  window.addEventListener('scroll', repositionPin, { passive: true });
  window.addEventListener('resize', repositionPin);
}

function repositionPin() {
  if (!pinButton || !pinTarget) return;
  if (!document.contains(pinTarget)) {
    hidePinNow();
    return;
  }
  const r = pinTarget.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    pinButton.style.display = 'none';
    return;
  }
  pinButton.style.display = '';
  // Measure ourselves once so we can pick a side that fits. Reads
  // the pin's own size after it has been mounted with whatever
  // content showPin built.
  const pinRect = pinButton.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const margin = 6;

  const fitsBelow = r.bottom + margin + pinRect.height <= vh;
  const fitsAbove = r.top - margin - pinRect.height >= 0;
  const fitsRight = r.right + margin + pinRect.width <= vw;

  let pageTop: number;
  let pageLeft: number;
  if (fitsBelow) {
    pageTop = r.bottom + window.scrollY + margin;
    pageLeft = clampX(r.left + window.scrollX, pinRect.width, vw);
  } else if (fitsAbove) {
    pageTop = r.top + window.scrollY - margin - pinRect.height;
    pageLeft = clampX(r.left + window.scrollX, pinRect.width, vw);
  } else if (fitsRight) {
    pageTop = r.top + window.scrollY;
    pageLeft = r.right + window.scrollX + margin;
  } else {
    // Last resort: cling to the left edge of the anchor, going
    // outside the viewport rather than overlapping the trigger.
    pageTop = r.top + window.scrollY;
    pageLeft = Math.max(0, r.left + window.scrollX - margin - pinRect.width);
  }

  pinButton.style.top = `${pageTop}px`;
  pinButton.style.left = `${pageLeft}px`;
}

function clampX(pageLeft: number, pinWidth: number, vw: number): number {
  // Keep within viewport horizontal bounds even after page scroll.
  const min = window.scrollX + 4;
  const max = window.scrollX + vw - pinWidth - 4;
  if (max < min) return min;
  return Math.max(min, Math.min(max, pageLeft));
}

function scheduleHidePin() {
  if (pinHideTimer) clearTimeout(pinHideTimer);
  pinHideTimer = setTimeout(hidePinNow, HIDE_DELAY_MS);
}

function hidePinNow() {
  if (pinHideTimer) {
    clearTimeout(pinHideTimer);
    pinHideTimer = null;
  }
  if (pinButton) {
    pinButton.remove();
    pinButton = null;
  }
  pinTarget = null;
  window.removeEventListener('scroll', repositionPin);
  window.removeEventListener('resize', repositionPin);
}

// ─── Selection floating button (anchored to selection rect) ───────

export function showSelectionButton(sel: Selection, urls: string[]) {
  const root = ensureHost();
  if (selectionGraceTimer) {
    clearTimeout(selectionGraceTimer);
    selectionGraceTimer = null;
  }
  if (selectionButton) {
    updateSelectionLabel(urls);
    placeAtSelection(selectionButton, sel);
    bindSelectionClick(urls);
    return;
  }
  const btn = document.createElement('div');
  btn.className = 'btn';
  btn.innerHTML = `
    <span class="body"><img alt="" /><span class="lbl"></span></span>
    <span class="x" title="dismiss">✕</span>
  `;
  (btn.querySelector('img') as HTMLImageElement).src = iconSrc;
  updateSelectionLabel(urls, btn);

  btn.addEventListener('mousedown', (ev) => ev.preventDefault());
  btn.querySelector('.x')!.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    removeSelectionButton();
  });

  root.appendChild(btn);
  selectionButton = btn;
  placeAtSelection(btn, sel);
  bindSelectionClick(urls);
}

function bindSelectionClick(urls: string[]) {
  if (!selectionButton) return;
  const body = selectionButton.querySelector<HTMLElement>('.body')!;
  // Replace listener by cloning the node.
  const fresh = body.cloneNode(true) as HTMLElement;
  body.replaceWith(fresh);
  fresh.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (urls.length === 1) sendCapture(urls[0], { interactive: true });
    else sendBatch(urls);
    removeSelectionButton();
  });
}

function updateSelectionLabel(urls: string[], target?: HTMLElement) {
  const btn = target ?? selectionButton;
  if (!btn) return;
  const lbl = btn.querySelector('.lbl') as HTMLElement | null;
  if (!lbl) return;
  lbl.textContent =
    urls.length > 1 ? `Download Selected (${urls.length})` : 'Download Selected';
}

function placeAtSelection(btn: HTMLElement, sel: Selection) {
  if (sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return;
  // Anchor below the selection, left-aligned to its leading edge.
  // Falls back to above the selection if there is no room below.
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const margin = 8;
  const pinH = btn.getBoundingClientRect().height || 44;
  const pinW = btn.getBoundingClientRect().width || 220;
  let top: number;
  if (r.bottom + margin + pinH <= vh) {
    top = r.bottom + window.scrollY + margin;
  } else if (r.top - margin - pinH >= 0) {
    top = r.top + window.scrollY - margin - pinH;
  } else {
    top = window.scrollY + Math.max(0, vh - pinH - margin);
  }
  let left = r.left + window.scrollX;
  const min = window.scrollX + 4;
  const max = window.scrollX + vw - pinW - 4;
  if (max >= min) left = Math.max(min, Math.min(max, left));
  btn.style.left = `${left}px`;
  btn.style.top = `${top}px`;
}

/** Called when the user collapses the selection. Schedules a grace
 *  timer; cancelled if a new selection is made. Safe to call when
 *  the button isn't visible yet — a pending show timer will check
 *  on materialization. */
export function scheduleSelectionDismiss() {
  if (selectionGraceTimer) clearTimeout(selectionGraceTimer);
  selectionGraceTimer = setTimeout(removeSelectionButton, SELECTION_GRACE_MS);
}

// Belt-and-suspenders: any click outside the pin while a selection
// button is on screen schedules dismiss. Catches the case where the
// browser doesn't fire `selectionchange` for the precise interaction
// the user just did (some sites preventDefault on mouseup).
document.addEventListener(
  'mousedown',
  (ev) => {
    if (!selectionButton) return;
    const t = ev.target as Node | null;
    if (t && selectionButton.contains(t)) return;
    scheduleSelectionDismiss();
  },
  { passive: true, capture: true },
);

export function removeSelectionButton() {
  if (selectionGraceTimer) {
    clearTimeout(selectionGraceTimer);
    selectionGraceTimer = null;
  }
  if (selectionButton) {
    selectionButton.remove();
    selectionButton = null;
  }
}

// ─── Shared lifecycle ─────────────────────────────────────────────

export function removeAllButtons() {
  clearDetected();
  hidePinNow();
  removeSelectionButton();
  stopPinHoverTracking();
  if (hostEl) {
    hostEl.remove();
    hostEl = null;
    shadow = null;
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
