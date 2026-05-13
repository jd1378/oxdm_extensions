import { startScanner, stop, onSelectionChange } from '@/src/content/scanner';
import { extractUrls } from '@/src/shared/heuristics';
import { getSettings, onSettingsChange } from '@/src/shared/state';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    let { enabled, injectButton, scanIntervalMs } = await getSettings();
    let handle = enabled && injectButton ? startScanner(scanIntervalMs) : null;

    onSettingsChange((s) => {
      if (s.enabled && s.injectButton) {
        if (!handle) handle = startScanner(s.scanIntervalMs);
      } else {
        if (handle) {
          stop();
          handle = null;
        }
      }
    });

    browser.runtime.onMessage.addListener((msg: any) => {
      if (msg?.kind === 'oxdm-context-selection') {
        const sel = window.getSelection();
        if (!sel) return;
        const urls = extractUrls(sel.toString());
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
    });
  },
});
