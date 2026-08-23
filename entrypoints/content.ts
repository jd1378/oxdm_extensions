import { startScanner, stop } from '@/src/content/scanner';
import { urlsFromSelection } from '@/src/shared/heuristics';
import { getSettings, onSettingsChange, type Settings } from '@/src/shared/state';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    let settings = await getSettings();
    let connState: string = 'disconnected';
    let handle: ReturnType<typeof startScanner> | null = null;

    const reconcile = () => {
      // Auto-capture deliberately absent: the pin is a manual send,
      // governed by its own toggle. It only needs oxdm reachable.
      const want = settings.injectButton && connState === 'connected';
      if (want && !handle) handle = startScanner();
      if (!want && handle) {
        stop();
        handle = null;
      }
    };

    // What a menu click should send, decided while the menu is being
    // asked for. Reading the selection when the click finally arrives
    // is too late: opening the menu on a link collapses the selection,
    // so the page would answer with the one link under the cursor and
    // the rest of the batch would be gone. `contextmenu` fires while
    // the selection is still intact, the same moment the browser fills
    // its own `selectionText`.
    let pending: string[] = [];
    document.addEventListener(
      'contextmenu',
      (ev) => {
        const target = ev.target as Element | null;
        const link = target?.closest?.('a[href]') as HTMLAnchorElement | null;
        const sel = window.getSelection();
        // Containment, not URL comparison: whether the click landed in
        // the selection is a DOM question, and matching the browser's
        // `linkUrl` against an anchor's `href` turns it into a string
        // one that encoding differences can quietly lose.
        const inSelection =
          !!sel && !sel.isCollapsed && !!target && sel.containsNode(target, true);
        // Inside a selection, the selection is the intent, links and
        // all. Outside it, only the link under the cursor is.
        pending = inSelection ? urlsFromSelection(sel!) : [];
        if (!pending.length && link?.href) pending = [link.href];
      },
      true,
    );

    // Ask for the current connection state once on bootstrap.
    browser.runtime
      .sendMessage({ kind: 'connection-status' })
      .then((r: any) => {
        connState = r?.state ?? 'disconnected';
        reconcile();
      })
      .catch(() => {});

    onSettingsChange((s: Settings) => {
      settings = s;
      reconcile();
    });

    browser.runtime.onMessage.addListener(
      (msg: any, _sender: any, sendResponse: (r: unknown) => void) => {
        if (msg?.kind === 'oxdm-conn') {
          connState = msg.state;
          reconcile();
          return;
        }
        // The reply carries how many URLs went out, so the background
        // can tell the user when a click found nothing rather than
        // leaving it looking like a broken extension.
        if (msg?.kind === 'oxdm-context-selection') {
          sendResponse({ sent: sendOneOrBatch(pending) });
          return;
        }
      },
    );
  },
});

/** Returns how many URLs were handed over, for the caller to report. */
function sendOneOrBatch(urls: string[]): number {
  if (urls.length === 1) {
    // `interactive` is the background's call — it owns the setting.
    browser.runtime.sendMessage({
      kind: 'capture',
      req: { url: urls[0], referrer: location.href },
    });
  } else if (urls.length > 1) {
    // `interactive` left unset: oxdm defaults batches to its triage
    // dialog, which is what a page-driven selection should get.
    browser.runtime.sendMessage({
      kind: 'batch',
      items: urls.map((u) => ({ url: u, referrer: location.href })),
    });
  }
  return urls.length;
}
