// In-page scanner. Periodic viewport sweep + hover + selection.
// Dedupes via WeakSet of elements + Set of URLs for synthetic targets.

import { isDownloadishElement, urlsFromSelection, isPublicHttpUrl } from '@/src/shared/heuristics';
import {
  attachPin,
  removeAllButtons,
  removeSelectionButton,
  showSelectionButton,
} from './injector';

type StopFn = () => void;

interface ScannerHandle {
  stop: StopFn;
}

const seenElements = new WeakSet<Element>();
let intervalHandle: number | null = null;
let observerHandle: MutationObserver | null = null;
let active = false;

export function startScanner(intervalMs: number): ScannerHandle {
  if (active) return { stop };
  active = true;

  runScan();
  intervalHandle = self.setInterval(runScan, intervalMs);

  // hover triggers
  document.addEventListener('mouseover', onMouseOver, { passive: true });

  // selection trigger
  document.addEventListener('selectionchange', onSelectionChange, {
    passive: true,
  });

  // stop interval when page is fully loaded; do one final scan
  const onLoad = () => {
    if (intervalHandle != null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    runScan();
  };
  if (document.readyState === 'complete') {
    setTimeout(onLoad, 0);
  } else {
    window.addEventListener('load', onLoad, { once: true });
  }

  // observe SPA navigations + new nodes (debounced via timer)
  observerHandle = new MutationObserver(() => {
    // cheap: rely on the periodic loop; just mark scan dirty
  });
  observerHandle.observe(document.documentElement, {
    subtree: true,
    childList: true,
  });

  return { stop };
}

export function stop() {
  if (!active) return;
  active = false;
  if (intervalHandle != null) clearInterval(intervalHandle);
  intervalHandle = null;
  observerHandle?.disconnect();
  observerHandle = null;
  document.removeEventListener('mouseover', onMouseOver);
  document.removeEventListener('selectionchange', onSelectionChange);
  removeAllButtons();
}

function runScan() {
  if (!active) return;
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const a of anchors) {
    if (seenElements.has(a)) continue;
    if (!isDownloadishElement(a)) continue;
    if (!a.href || !isPublicHttpUrl(a.href)) continue;
    seenElements.add(a);
    attachPin(a, a.href);
  }
}

let hoverTimer: number | null = null;
function onMouseOver(ev: MouseEvent) {
  const t = ev.target as Element | null;
  if (!t) return;
  const a = t.closest('a, button, [role=button]');
  if (!a || seenElements.has(a)) return;
  if (hoverTimer != null) clearTimeout(hoverTimer);
  hoverTimer = self.setTimeout(() => {
    if (!isDownloadishElement(a)) return;
    seenElements.add(a);
    const anchor =
      a instanceof HTMLAnchorElement ? a : a.closest<HTMLAnchorElement>('a');
    if (anchor && anchor.href && isPublicHttpUrl(anchor.href)) {
      attachPin(anchor, anchor.href);
    }
  }, 80);
}

let selectionTimer: number | null = null;
let lastSelectionKey = '';
function onSelectionChange() {
  if (selectionTimer != null) clearTimeout(selectionTimer);
  selectionTimer = self.setTimeout(handleSelection, 250);
}

function handleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    removeSelectionButton();
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

