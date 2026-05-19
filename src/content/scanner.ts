// In-page scanner. Mutation-driven: a deferred initial sweep + a
// MutationObserver pick up dynamically inserted anchors. Hover stays
// as a last-resort fallback for cases the observer misses (e.g.
// closed shadow roots).

import {
  isDownloadishElement,
  urlsFromSelection,
  isPublicHttpUrl,
} from '@/src/shared/heuristics';
import {
  registerDetected,
  removeAllButtons,
  removeSelectionButton,
  scheduleSelectionDismiss,
  showSelectionButton,
  startPinHoverTracking,
  stopPinHoverTracking,
} from './injector';

interface ScannerHandle {
  stop: () => void;
}

// Defer the first scan + observer attach. Most pages slam the DOM in
// the first couple of seconds of load; coalescing that storm into a
// single sweep avoids thrashing.
const INITIAL_DEFER_MS = 3000;
// Drop the pending set and queue one full re-scan once the burst gets
// pathological (chat / feed sites can fire thousands of mutations per
// second; per-node walks would peg a core).
const PENDING_NODE_BUDGET = 200;
// Idle-callback fallback delay when requestIdleCallback is absent.
const FLUSH_FALLBACK_MS = 200;
// When the budget is exceeded we stop processing mutations entirely
// until the page sits quiet for this long. A storming page is almost
// certainly not where the user is hunting for download links, and the
// cheapest correct thing to do is wait it out. Each overflow during
// the cooldown extends it — only sustained quiet ends the timer.
const STORM_COOLDOWN_MS = 2000;

const seenElements = new WeakSet<Element>();
let observer: MutationObserver | null = null;
let pendingNodes: Set<Node> | null = null;
let flushHandle: number | null = null;
let stormCooldownTimer: number | null = null;
let initialDeferTimer: number | null = null;
let active = false;

export function startScanner(): ScannerHandle {
  if (active) return { stop };
  active = true;

  startPinHoverTracking();
  document.addEventListener('mouseover', onMouseOver, { passive: true });
  document.addEventListener('selectionchange', onSelectionChange, {
    passive: true,
  });

  // Defer the first sweep so we don't fight the page's load-time DOM
  // churn. Observer attaches at the same moment for the same reason.
  initialDeferTimer = self.setTimeout(() => {
    initialDeferTimer = null;
    if (!active) return;
    runScan();
    attachObserver();
  }, INITIAL_DEFER_MS);

  // Always run one more sweep on `load` — pages that ship most of
  // their anchors in the initial HTML benefit, and it's cheap thanks
  // to the WeakSet dedupe.
  const onLoad = () => {
    if (!active) return;
    runScan();
  };
  if (document.readyState === 'complete') {
    setTimeout(onLoad, 0);
  } else {
    window.addEventListener('load', onLoad, { once: true });
  }

  return { stop };
}

export function stop() {
  if (!active) return;
  active = false;
  if (initialDeferTimer != null) {
    clearTimeout(initialDeferTimer);
    initialDeferTimer = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (flushHandle != null) {
    cancelFlush(flushHandle);
    flushHandle = null;
  }
  if (stormCooldownTimer != null) {
    clearTimeout(stormCooldownTimer);
    stormCooldownTimer = null;
  }
  pendingNodes = null;
  if (hoverTimer != null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (selectionTimer != null) {
    clearTimeout(selectionTimer);
    selectionTimer = null;
  }
  lastSelectionKey = '';
  document.removeEventListener('mouseover', onMouseOver);
  document.removeEventListener('selectionchange', onSelectionChange);
  stopPinHoverTracking();
  removeAllButtons();
}

function attachObserver() {
  // Graceful degradation: ancient runtimes without MutationObserver
  // get the single load-time sweep + hover fallback. Nothing more.
  if (typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function onMutations(records: MutationRecord[]) {
  if (!active) return;
  // Storm cooldown: a previous batch overflowed the budget; ignore
  // mutations until the page goes quiet. Each new batch during the
  // cooldown extends it.
  if (stormCooldownTimer != null) {
    enterStormCooldown();
    return;
  }
  for (const r of records) {
    if (r.type !== 'childList') continue;
    const added = r.addedNodes;
    for (let i = 0; i < added.length; i++) {
      const n = added[i];
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (!pendingNodes) pendingNodes = new Set();
      pendingNodes.add(n);
      if (pendingNodes.size >= PENDING_NODE_BUDGET) {
        enterStormCooldown();
        return;
      }
    }
  }
  if (pendingNodes && pendingNodes.size > 0 && flushHandle == null) {
    flushHandle = scheduleFlush(flushPending);
  }
}

function enterStormCooldown() {
  // Discard any pending incremental work. We'll do one full sweep
  // when the storm settles; the WeakSet dedupes already-registered
  // anchors so it's cheap.
  pendingNodes = null;
  if (flushHandle != null) {
    cancelFlush(flushHandle);
    flushHandle = null;
  }
  if (stormCooldownTimer != null) clearTimeout(stormCooldownTimer);
  stormCooldownTimer = self.setTimeout(() => {
    stormCooldownTimer = null;
    if (!active) return;
    runScan();
  }, STORM_COOLDOWN_MS);
}

function flushPending() {
  flushHandle = null;
  if (!active) return;
  const batch = pendingNodes;
  pendingNodes = null;
  if (!batch) return;
  for (const n of batch) {
    const el = n as Element;
    // The element itself might be the anchor.
    if (el.tagName === 'A') evaluateAnchor(el as HTMLAnchorElement);
    // Descendants might contain anchors that were inserted with the
    // subtree in a single mutation record.
    const anchors = el.querySelectorAll?.<HTMLAnchorElement>('a[href]');
    if (!anchors) continue;
    for (const a of anchors) evaluateAnchor(a);
  }
}

function evaluateAnchor(a: HTMLAnchorElement) {
  if (seenElements.has(a)) return;
  if (!a.href) return;
  if (!isDownloadishElement(a)) return;
  if (!isPublicHttpUrl(a.href)) return;
  seenElements.add(a);
  registerDetected(a);
}

function runScan() {
  if (!active) return;
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const a of anchors) evaluateAnchor(a);
}

type IdleHandle = number;
function scheduleFlush(cb: () => void): IdleHandle {
  const ric = (self as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined;
  if (ric) return ric(cb, { timeout: FLUSH_FALLBACK_MS * 2 });
  return self.setTimeout(cb, FLUSH_FALLBACK_MS);
}
function cancelFlush(h: IdleHandle) {
  const cic = (self as any).cancelIdleCallback as
    | ((h: number) => void)
    | undefined;
  if (cic) cic(h);
  else clearTimeout(h);
}

let hoverTimer: number | null = null;
function onMouseOver(ev: MouseEvent) {
  const t = ev.target as Element | null;
  if (!t) return;
  const a = t.closest<HTMLAnchorElement>('a[href]');
  if (!a || seenElements.has(a)) return;
  if (hoverTimer != null) clearTimeout(hoverTimer);
  hoverTimer = self.setTimeout(() => {
    if (!isDownloadishElement(a)) return;
    if (!isPublicHttpUrl(a.href)) return;
    seenElements.add(a);
    registerDetected(a);
  }, 80);
}

let selectionTimer: number | null = null;
let lastSelectionKey = '';
// Short grace so accidental drag-selections / double-clicks don't
// flash the floating button. Collapse handling stays un-debounced so
// the dismiss timer remains responsive.
const SELECTION_SHOW_DELAY_MS = 500;
function onSelectionChange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    if (selectionTimer != null) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    handleSelection();
    return;
  }
  if (selectionTimer != null) clearTimeout(selectionTimer);
  selectionTimer = self.setTimeout(handleSelection, SELECTION_SHOW_DELAY_MS);
}

function handleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    scheduleSelectionDismiss();
    lastSelectionKey = '';
    return;
  }
  const urls = urlsFromSelection(sel);
  if (!urls.length) {
    removeSelectionButton();
    lastSelectionKey = '';
    return;
  }
  const key = urls.join('\n');
  if (key === lastSelectionKey) return;
  lastSelectionKey = key;
  showSelectionButton(sel, urls);
}
