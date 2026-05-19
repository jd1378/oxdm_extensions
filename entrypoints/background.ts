import { client } from '@/src/shared/ipc';
import {
  getCachedRules,
  getSettings,
  onSettingsChange,
  setCachedRules,
  setSettings,
  type CaptureRules,
  type Settings,
} from '@/src/shared/state';
import { extOf, isPublicHttpUrl } from '@/src/shared/heuristics';
import type { CaptureRequest, RuntimeMsg } from '@/src/shared/messages';

let settings: Settings;
let rules: CaptureRules;

export default defineBackground(() => {
  init();
});

async function init() {
  settings = await getSettings();
  rules = await getCachedRules();
  applyAction();
  applyClientConfig(settings);
  if (settings.enabled) client.ensureOpen();

  onSettingsChange((s) => {
    const wasEnabled = settings.enabled;
    settings = s;
    applyAction();
    applyClientConfig(s);
    if (s.enabled && !wasEnabled) client.ensureOpen();
    else if (!s.enabled && wasEnabled) client.stop();
  });

  let lastSyncedState = '';
  client.onState((cs) => {
    if (cs === 'authed' && lastSyncedState !== 'authed') {
      void syncRules();
    }
    lastSyncedState = cs;
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

  // `icons` on context menu items is Firefox-only. Chromium throws
  // "Unexpected property: 'icons'" when we include it, so we attach
  // the field only on the Firefox build.
  // Cast: WXT generates a strict overload typed to entrypoint paths
  // only; static asset URLs need to bypass it.
  const iconUrl = (browser.runtime.getURL as (p: string) => string)(
    '/icon-16.png',
  );
  const withIcon = (props: Record<string, unknown>) =>
    import.meta.env.BROWSER === 'firefox'
      ? { ...props, icons: { '16': iconUrl } }
      : props;
  // Chromium auto-groups every extension menu item under a single
  // 'oxdm' parent the moment we register more than one. Stick to a
  // single item across link / selection / page contexts; retitle
  // dynamically when the content script signals what we're over.
  browser.contextMenus.create(withIcon({
    id: 'oxdm-send',
    title: 'Download with oxdm',
    contexts: ['link', 'selection', 'page'],
  }) as any);
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
    transport: s.transport,
  });
}

async function syncRules() {
  const wire = await client.getRules();
  if (!wire) return;
  const next: CaptureRules = {
    minSize: wire.min_size ?? 0,
    skipDomains: wire.skip_domains ?? [],
    skipExtensions: (wire.skip_extensions ?? []).map((s) =>
      s.toLowerCase().replace(/^\./, ''),
    ),
    skipMimePrefixes: (wire.skip_mime_prefixes ?? []).map((s) => s.toLowerCase()),
    allowExtensions: (wire.allow_extensions ?? []).map((s) =>
      s.toLowerCase().replace(/^\./, ''),
    ),
    allowMimePrefixes: (wire.allow_mime_prefixes ?? []).map((s) => s.toLowerCase()),
  };
  rules = next;
  await setCachedRules(next);
}

function applyAction() {
  // Single unified icon; capture state shows as a badge over it so we
  // don't need a second artwork variant for the disabled case.
  if (settings.enabled) {
    browser.action.setBadgeText({ text: '' });
  } else {
    browser.action.setBadgeText({ text: 'off' });
    browser.action.setBadgeBackgroundColor?.({ color: '#6b7280' });
  }
}

async function handleRuntimeMsg(msg: RuntimeMsg): Promise<unknown> {
  switch (msg.kind) {
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
  // Retitle the single menu item. Selection count wins over page
  // count when both are present.
  let title = 'Download with oxdm';
  if (selection > 1) title = `Download ${selection} selected links with oxdm`;
  else if (selection === 1) title = 'Download selected link with oxdm';
  else if (page > 1) title = `Download ${page} detected links with oxdm`;
  try {
    browser.contextMenus.update('oxdm-send', { title } as any);
  } catch {}
}

async function onContextMenu(info: any, tab?: any) {
  if (!settings.enabled || info.menuItemId !== 'oxdm-send') return;
  // Single item across all contexts — decide intent from info shape.
  if (info.linkUrl) {
    if (!isPublicHttpUrl(info.linkUrl)) {
      notify('oxdm', `Refused non-public URL: ${info.linkUrl}`);
      return;
    }
    const req = await buildCapture(info.linkUrl, tab, { interactive: true });
    await client.capture(req);
    return;
  }
  if (info.selectionText) {
    if (tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { kind: 'oxdm-context-selection' });
    }
    return;
  }
  if (tab?.id != null) {
    browser.tabs.sendMessage(tab.id, { kind: 'oxdm-context-page' });
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
    interactive: true,
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
  if (rules.minSize > 0 && item.fileSize > 0 && item.fileSize < rules.minSize) return;
  const mime = (item.mime ?? '').toLowerCase();
  if (rules.skipMimePrefixes.some((p) => mime.startsWith(p))) return;
  const ext = extOf(item.url) ?? extOf(item.filename ?? '');
  if (ext && rules.skipExtensions.includes(ext)) return;
  // Allow lists are subtractive after skips: when non-empty, require a
  // positive match. Either dimension alone is sufficient.
  const hasAllow =
    rules.allowExtensions.length > 0 || rules.allowMimePrefixes.length > 0;
  if (hasAllow) {
    const extOk = !!ext && rules.allowExtensions.includes(ext);
    const mimeOk = !!mime && rules.allowMimePrefixes.some((p) => mime.startsWith(p));
    if (!extOk && !mimeOk) return;
  }
  try {
    const host = new URL(item.url).hostname;
    if (rules.skipDomains.some((d) => host === d || host.endsWith('.' + d))) return;
  } catch {}

  try {
    await browser.downloads.cancel(item.id);
    await browser.downloads.erase({ id: item.id });
  } catch {}

  const cookies = await readCookieHeader(item.url);
  const req: CaptureRequest = {
    url: item.url,
    filename: item.filename ? item.filename.split(/[\\/]/).pop() : undefined,
    referrer: item.referrer || undefined,
    cookies,
    user_agent: navigator.userAgent,
    mime_type: item.mime || undefined,
    size: item.fileSize > 0 ? item.fileSize : undefined,
    interactive: true,
  };
  const r = await client.capture(req);
  if (r.result === 'rejected') notify('oxdm rejected download', r.reason);
}

function notify(title: string, message: string) {
  try {
    browser.notifications?.create?.({
      type: 'basic',
      iconUrl: 'icon-48.png',
      title,
      message,
    });
  } catch {}
}
