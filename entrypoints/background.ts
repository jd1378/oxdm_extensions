import { client } from '@/src/shared/ipc';
import {
  getSettings,
  onSettingsChange,
  setSettings,
  type Settings,
} from '@/src/shared/state';
import { extOf, isPublicHttpUrl } from '@/src/shared/heuristics';
import type { CaptureRequest, RuntimeMsg } from '@/src/shared/messages';

let settings: Settings;
const ourCancellations = new Set<number>();

export default defineBackground(() => {
  init();
});

async function init() {
  settings = await getSettings();
  applyAction();
  applyClientConfig(settings);
  if (settings.enabled) client.ensureOpen();

  onSettingsChange((s) => {
    const wasEnabled = settings.enabled;
    settings = s;
    applyAction();
    applyClientConfig(s);
    if (s.enabled && !wasEnabled) client.ensureOpen();
  });

  client.onState((cs) => {
    browser.action.setTitle({
      title: `oxdm — ${settings.enabled ? 'on' : 'off'} (${cs})`,
    });
    // Tell every content script whether the host is reachable so they
    // can show / hide injected affordances. Best-effort broadcast.
    browser.tabs
      .query({})
      .then((tabs) => {
        for (const t of tabs) {
          if (t.id == null) continue;
          browser.tabs
            .sendMessage(t.id, { kind: 'oxdm-conn', state: cs })
            .catch(() => {});
        }
      })
      .catch(() => {});
  });

  browser.action.onClicked.addListener(async () => {
    await setSettings({ enabled: !settings.enabled });
  });

  const iconUrl = browser.runtime.getURL('/icon-16-on.png');
  // Chromium supports `icons` on context menu items; Firefox ignores
  // unknown fields. Either way the rest of the entry works.
  // Link context: always sensible — Chrome already gates `contexts:['link']`.
  browser.contextMenus.create({
    id: 'oxdm-send-link',
    title: 'Download with oxdm',
    contexts: ['link'],
    icons: { '16': iconUrl },
  } as any);
  // Selection context: shown dynamically by the content script when a
  // selection actually contains at least one URL. Two separate items
  // so the title reflects singular vs plural without rewrites.
  browser.contextMenus.create({
    id: 'oxdm-send-selection-one',
    title: 'Download selected link with oxdm',
    contexts: ['selection'],
    visible: false,
    icons: { '16': iconUrl },
  } as any);
  browser.contextMenus.create({
    id: 'oxdm-send-selection-all',
    title: 'Download all selected links with oxdm',
    contexts: ['selection'],
    visible: false,
    icons: { '16': iconUrl },
  } as any);
  // Page context: shown when the in-page scanner has at least one hit.
  browser.contextMenus.create({
    id: 'oxdm-send-page',
    title: 'Download all detected links with oxdm',
    contexts: ['page'],
    visible: false,
    icons: { '16': iconUrl },
  } as any);
  browser.contextMenus.onClicked.addListener(onContextMenu);

  browser.downloads.onCreated.addListener(onDownloadCreated);

  browser.runtime.onMessage.addListener(
    (msg: RuntimeMsg, _sender, sendResponse) => {
      handleRuntimeMsg(msg).then(sendResponse);
      return true;
    },
  );
}

function applyClientConfig(s: Settings) {
  client.configure({
    port: s.port,
    token: s.token,
    hostName: s.nativeHostName,
    transport: s.transport,
  });
}

function applyAction() {
  const suffix = settings.enabled ? 'on' : 'off';
  browser.action.setIcon({
    path: {
      '16': `icon-16-${suffix}.png`,
      '32': `icon-32-${suffix}.png`,
      '48': `icon-48-${suffix}.png`,
      '128': `icon-128-${suffix}.png`,
    },
  });
}

async function handleRuntimeMsg(msg: RuntimeMsg): Promise<unknown> {
  switch (msg.kind) {
    case 'get-state':
      return { settings, connection: client.getState() };
    case 'set-enabled':
      await setSettings({ enabled: msg.enabled });
      return { ok: true };
    case 'capture':
      return client.capture(msg.req);
    case 'batch':
      return client.batch(msg.items);
    case 'connection-status':
      return { state: client.getState() };
    case 'menu-state':
      await applyMenuState(msg.selection, msg.page);
      return { ok: true };
  }
}

async function applyMenuState(selection: number, page: number) {
  // Selection: zero hides both; one shows the singular; >1 shows the
  // plural. Page: zero hides; any positive shows the "all detected"
  // entry. Failures (e.g. menu not yet ready) are ignored.
  const set = (id: string, visible: boolean) => {
    try {
      browser.contextMenus.update(id, { visible });
    } catch {}
  };
  set('oxdm-send-selection-one', selection === 1);
  set('oxdm-send-selection-all', selection > 1);
  set('oxdm-send-page', page > 0);
}

async function onContextMenu(info: any, tab?: any) {
  if (!settings.enabled) return;
  if (info.menuItemId === 'oxdm-send-link' && info.linkUrl) {
    if (!isPublicHttpUrl(info.linkUrl)) {
      notify('oxdm', `Refused non-public URL: ${info.linkUrl}`);
      return;
    }
    const req = await buildCapture(info.linkUrl, tab, { interactive: true });
    await client.capture(req);
  } else if (
    (info.menuItemId === 'oxdm-send-selection-one' ||
      info.menuItemId === 'oxdm-send-selection-all') &&
    info.selectionText
  ) {
    if (tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { kind: 'oxdm-context-selection' });
    }
  } else if (info.menuItemId === 'oxdm-send-page') {
    if (tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { kind: 'oxdm-context-page' });
    }
  }
}

async function buildCapture(
  url: string,
  tab?: any,
  extras?: Partial<CaptureRequest>,
): Promise<CaptureRequest> {
  const cookies = await readCookieHeader(url);
  return {
    url,
    referrer: tab?.url,
    cookies,
    user_agent: navigator.userAgent,
    interactive: false,
    ...(extras ?? {}),
  };
}

async function readCookieHeader(url: string): Promise<string | undefined> {
  try {
    const list = await browser.cookies.getAll({ url });
    if (!list.length) return undefined;
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return undefined;
  }
}

async function onDownloadCreated(item: any) {
  if (!settings.enabled) return;
  if (!item.url || !isPublicHttpUrl(item.url)) return;
  if (settings.minSize > 0 && item.fileSize > 0 && item.fileSize < settings.minSize) return;
  const mime = item.mime ?? '';
  if (settings.skipMimePrefixes.some((p) => mime.startsWith(p))) return;
  const ext = extOf(item.url) ?? extOf(item.filename ?? '');
  if (ext && settings.skipExtensions.includes(ext)) return;
  try {
    const host = new URL(item.url).hostname;
    if (settings.skipDomains.some((d) => host === d || host.endsWith('.' + d))) return;
  } catch {}

  try {
    ourCancellations.add(item.id);
    await browser.downloads.cancel(item.id);
    await browser.downloads.erase({ id: item.id });
  } catch {}
  ourCancellations.delete(item.id);

  const cookies = await readCookieHeader(item.url);
  const req: CaptureRequest = {
    url: item.url,
    filename: item.filename ? item.filename.split(/[\\/]/).pop() : undefined,
    referrer: item.referrer || undefined,
    cookies,
    user_agent: navigator.userAgent,
    mime_type: item.mime || undefined,
    size: item.fileSize > 0 ? item.fileSize : undefined,
    interactive: false,
  };
  const r = await client.capture(req);
  if (r.result === 'rejected') notify('oxdm rejected download', r.reason);
}

function notify(title: string, message: string) {
  try {
    browser.notifications?.create?.({
      type: 'basic',
      iconUrl: 'icon-48-on.png',
      title,
      message,
    });
  } catch {}
}
