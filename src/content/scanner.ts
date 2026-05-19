// In-page scanner. Periodic DOM sweep records "download-ish" anchors;
// the injector only materializes a pin when the cursor approaches one
// of those anchors. Selection changes drive a separate floating button.

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

const seenElements = new WeakSet<Element>();
let intervalHandle: number | null = null;
let active = false;

export function startScanner(intervalMs: number): ScannerHandle {
  if (active) return { stop };
  active = true;

  runScan();
  intervalHandle = self.setInterval(runScan, intervalMs);
  startPinHoverTracking();

  // Hover on a previously-unscanned candidate → run heuristic right
  // away so we don't make the user wait for the periodic sweep.
  document.addEventListener('mouseover', onMouseOver, { passive: true });

  document.addEventListener('selectionchange', onSelectionChange, {
    passive: true,
  });

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

  return { stop };
}

export function stop() {
  if (!active) return;
  active = false;
  if (intervalHandle != null) clearInterval(intervalHandle);
  intervalHandle = null;
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

function runScan() {
  if (!active) return;
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const a of anchors) {
    if (seenElements.has(a)) continue;
    if (!isDownloadishElement(a)) continue;
    if (!a.href || !isPublicHttpUrl(a.href)) continue;
    seenElements.add(a);
    registerDetected(a);
  }
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
// 2s grace so accidental drag-selections / double-clicks don't flash
// the floating button. The handler still runs immediately on
// "selection collapsed" (no debounce there) to keep the dismiss
// timer responsive.
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
    // Keep the button on screen for SELECTION_GRACE_MS so accidental
    // clicks outside the selected text don't wipe it instantly.
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
