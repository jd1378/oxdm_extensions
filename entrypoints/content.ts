import { startScanner, stop } from '@/src/content/scanner';
import { isDownloadishUrl, urlsFromSelection } from '@/src/shared/heuristics';
import { getSettings, onSettingsChange, type Settings } from '@/src/shared/state';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    let settings = await getSettings();
    let connState: string = 'disconnected';
    let handle: ReturnType<typeof startScanner> | null = null;

    const reconcile = () => {
      const want =
        settings.enabled && settings.injectButton && connState === 'connected';
      if (want && !handle) handle = startScanner();
      if (!want && handle) {
        stop();
        handle = null;
      }
    };

    // Report selection / page URL counts to background just before
    // any context menu opens, so visibility can be set per-tab. We
    // listen on `contextmenu` rather than polling because the menu
    // is only assembled at that moment.
    let lastReport = { selection: -1, page: -1 };
    const reportCounts = (ev?: MouseEvent) => {
      // If the right-click target is a link, the browser already
      // shows our 'oxdm-send-link' entry — suppress the selection
      // variant so we don't get two 'Download with oxdm' rows.
      const target = ev?.target as Element | null;
      const onLink = !!target?.closest?.('a[href]');
      const selUrls = (() => {
        if (onLink) return 0;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return 0;
        return urlsFromSelection(sel).length;
      })();
      const pageUrls = onLink
        ? 0
        : (() => {
            const seen = new Set<string>();
            for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
              if (isDownloadishUrl(a.href)) seen.add(a.href);
            }
            return seen.size;
          })();
      if (
        lastReport.selection === selUrls &&
        lastReport.page === pageUrls
      ) return;
      lastReport = { selection: selUrls, page: pageUrls };
      browser.runtime
        .sendMessage({ kind: 'menu-state', selection: selUrls, page: pageUrls })
        .catch(() => {});
    };
    document.addEventListener('contextmenu', reportCounts, true);

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

    browser.runtime.onMessage.addListener((msg: any) => {
      if (msg?.kind === 'oxdm-conn') {
        connState = msg.state;
        reconcile();
        return;
      }
      if (msg?.kind === 'oxdm-context-selection') {
        const sel = window.getSelection();
        if (!sel) return;
        sendOneOrBatch(urlsFromSelection(sel));
        return;
      }
      if (msg?.kind === 'oxdm-context-page') {
        const seen = new Set<string>();
        for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
          if (isDownloadishUrl(a.href)) seen.add(a.href);
        }
        sendOneOrBatch([...seen]);
        return;
      }
    });
  },
});

function sendOneOrBatch(urls: string[]) {
  if (urls.length === 1) {
    browser.runtime.sendMessage({
      kind: 'capture',
      req: { url: urls[0], referrer: location.href, interactive: true },
    });
  } else if (urls.length > 1) {
    browser.runtime.sendMessage({
      kind: 'batch',
      items: urls.map((u) => ({
        url: u,
        referrer: location.href,
        interactive: false,
      })),
    });
  }
}
