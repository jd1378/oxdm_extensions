import { client } from '@/src/shared/ipc';
import {
  getSettings,
  onSettingsChange,
  setSettings,
  type Settings,
} from '@/src/shared/state';
import { extOf } from '@/src/shared/heuristics';
import type { CaptureRequest, RuntimeMsg } from '@/src/shared/messages';

let settings: Settings;
const ourCancellations = new Set<number>();

export default defineBackground(() => {
  init();
});

async function init() {
  settings = await getSettings();
  applyAction();
  client.configure(settings.port, settings.token);
  if (settings.enabled) client.ensureOpen();

  onSettingsChange((s) => {
    const wasEnabled = settings.enabled;
    settings = s;
    applyAction();
    client.configure(s.port, s.token);
    if (s.enabled && !wasEnabled) client.ensureOpen();
  });

  client.onState((cs) => {
    browser.action.setTitle({
      title: `oxdm — ${settings.enabled ? 'on' : 'off'} (${cs})`,
    });
  });

  browser.action.onClicked.addListener(async () => {
    await setSettings({ enabled: !settings.enabled });
  });

  browser.contextMenus.create({
    id: 'oxdm-send-link',
    title: 'Send link to oxdm',
    contexts: ['link'],
  });
  browser.contextMenus.create({
    id: 'oxdm-send-selection',
    title: 'Send links in selection to oxdm',
    contexts: ['selection'],
  });
  browser.contextMenus.onClicked.addListener(onContextMenu);

  browser.downloads.onCreated.addListener(onDownloadCreated);

  browser.runtime.onMessage.addListener(
    (msg: RuntimeMsg, _sender, sendResponse) => {
      handleRuntimeMsg(msg).then(sendResponse);
      return true;
    },
  );
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
    case 'batch-prepare':
      await openBatchTab(msg.items);
      return { ok: true };
    case 'batch-send':
      return client.batch(msg.items);
    case 'evaluate':
      return client.evaluate(msg.url, { referrer: msg.referrer });
    case 'list-queues':
      return client.listQueues();
    case 'connection-status':
      return { state: client.getState() };
  }
}

async function onContextMenu(info: any, tab?: any) {
  if (!settings.enabled) return;
  if (info.menuItemId === 'oxdm-send-link' && info.linkUrl) {
    const req = await buildCapture(info.linkUrl, tab, { interactive: true });
    await client.capture(req);
  } else if (info.menuItemId === 'oxdm-send-selection' && info.selectionText) {
    if (tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { kind: 'oxdm-context-selection' });
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
  if (!item.url || !/^https?:/i.test(item.url)) return;
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

async function openBatchTab(items: CaptureRequest[]) {
  const data = encodeURIComponent(JSON.stringify(items));
  const url = browser.runtime.getURL('/batch.html') + `?data=${data}`;
  await browser.windows.create({
    url,
    type: 'popup',
    width: 720,
    height: 520,
  });
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
