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
      // Auto-capture deliberately absent: the pin is a manual send,
      // governed by its own toggle. It only needs oxdm reachable.
      const want = settings.injectButton && connState === 'connected';
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
      const target = ev?.target as Element | null;
      const linkHref = (target?.closest?.('a[href]') as HTMLAnchorElement | null)
        ?.href;
      const selUrls = (() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return 0;
        const urls = urlsFromSelection(sel);
        // Mirrors the send path below: a clicked link that isn't part
        // of the selection means the click landed outside it, so the
        // link alone is the intent.
        if (linkHref && !urls.includes(linkHref)) return 0;
        return urls.length;
      })();
      // The page-wide scan is the "nothing specific under the cursor"
      // fallback. A link there is specific.
      const pageUrls = linkHref
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
        const urls = sel && !sel.isCollapsed ? urlsFromSelection(sel) : [];
        // `fallbackUrl` is the link the click landed on, if any. It
        // stands in only when the selection yields nothing, and wins
        // outright when it isn't part of the selection, which means
        // the click was outside it.
        const link: string | undefined = msg.fallbackUrl;
        if (urls.length && (!link || urls.includes(link))) sendOneOrBatch(urls);
        else if (link) sendOneOrBatch([link]);
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
}
