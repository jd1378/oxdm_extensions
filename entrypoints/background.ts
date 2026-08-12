import { client } from '@/src/shared/ipc';
import { clearLogs, getLogs, pushLog } from '@/src/shared/log';
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
  // The connection is unconditional. It carries the context menu, the
  // in-page pin and the capture-rules sync, none of which depend on
  // auto-capture being on.
  client.ensureOpen();

  onSettingsChange((s) => {
    settings = s;
    applyAction();
    // Only re-open when the connection inputs actually moved.
    // `configure()` may have torn down a live session, and a fresh
    // token has to retry a token-rejected / wsTokenBlocked latch —
    // but toggling auto-capture or the pin has nothing to do with the
    // transport, and kicking the client there would jump the reconnect
    // backoff and log a fresh failure on every flip.
    if (applyClientConfig(s)) client.ensureOpen();
  });

  let lastSyncedState = '';
  // Whether the current session ever reached 'connected' — i.e. auth
  // verified, not just transport open. Reset on every disconnect.
  let reachedConnected = false;
  client.onError((e) => {
    void pushLog(
      'error',
      e.transport ? `ipc/${e.transport}` : 'ipc',
      e.message,
    );
    // Revert a stuck pin: only when we set the pin ourselves (from
    // an earlier auto-resolve) AND it failed before verification.
    // Explicit user choices are respected — keep failing visibly so
    // the user can fix the underlying problem.
    if (
      !reachedConnected &&
      e.transport &&
      settings.transport === e.transport &&
      settings.transportPinnedByAuto
    ) {
      void pushLog(
        'info',
        'ipc',
        `reverting transport to "auto" — pinned "${e.transport}" failed before verification`,
      );
      void setSettings({ transport: 'auto', transportPinnedByAuto: false });
    }
  });
  client.onState((cs) => {
    if (cs === 'connected' && lastSyncedState !== 'connected') {
      reachedConnected = true;
      void pushLog('info', 'ipc', 'connected to oxdm');
      // Learn what auto resolved to and persist it. Skips the
      // wasteful probe on subsequent startups.
      const active = client.getActiveTransport();
      if (settings.transport === 'auto' && active) {
        void pushLog(
          'info',
          'ipc',
          `pinning transport to "${active}" (auto resolved to it)`,
        );
        void setSettings({ transport: active, transportPinnedByAuto: true });
      }
      void syncRules();
    }
    if (cs === 'disconnected' || cs === 'error') {
      reachedConnected = false;
    }
    lastSyncedState = cs;
    browser.action.setTitle({
      title: `oxdm — ${cs}${settings.autoCapture ? '' : ', auto-capture off'}`,
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
    await setSettings({ autoCapture: !settings.autoCapture });
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

let lastConfiguredToken: string | null = null;
let lastConnKey: string | null = null;

/**
 * Push the transport settings into the client. Returns whether any of
 * them changed, i.e. whether the caller should re-open the connection.
 * The rest of the settings object is none of the client's business.
 */
function applyClientConfig(s: Settings): boolean {
  if (lastConfiguredToken !== null && lastConfiguredToken !== s.token) {
    void pushLog(
      'info',
      'settings',
      s.token
        ? `token updated (${s.token.length} chars)`
        : 'token cleared',
    );
  }
  lastConfiguredToken = s.token;
  const key = `${s.transport}|${s.port}|${s.token}`;
  const changed = lastConnKey !== null && key !== lastConnKey;
  lastConnKey = key;
  client.configure({
    port: s.port,
    token: s.token,
    transport: s.transport,
  });
  return changed;
}

let warnedAboutRulesMiss = false;
async function syncRules() {
  const wire = await client.getRules();
  if (!wire) {
    if (!warnedAboutRulesMiss) {
      warnedAboutRulesMiss = true;
      await pushLog(
        'warn',
        'rules',
        'oxdm did not return capture rules — your oxdm build may be older than this extension; using cached rules',
      );
    }
    return;
  }
  warnedAboutRulesMiss = false;
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
  // Single unified icon; auto-capture state shows as a badge over it
  // so we don't need a second artwork variant for the off case. The
  // badge says nothing about the connection — the popup does that.
  if (settings.autoCapture) {
    browser.action.setBadgeText({ text: '' });
  } else {
    browser.action.setBadgeText({ text: 'off' });
    browser.action.setBadgeBackgroundColor?.({ color: '#6b7280' });
  }
}

async function handleRuntimeMsg(msg: RuntimeMsg): Promise<unknown> {
  switch (msg.kind) {
    case 'capture': {
      // Content scripts can read neither the cookie jar nor settings
      // the host cares about, so every request they originate is
      // completed here. The URL is re-checked because this is the
      // trust boundary — content-side filtering is a UX filter, not
      // a guarantee.
      if (!isPublicHttpUrl(msg.req.url)) {
        return { result: 'rejected', reason: 'non-public URL refused' };
      }
      return client.capture(await enrich(msg.req));
    }
    case 'batch': {
      const allowed = msg.items.filter((i) => isPublicHttpUrl(i.url));
      const dropped = msg.items.length - allowed.length;
      if (dropped > 0) {
        void pushLog(
          'warn',
          'capture',
          `dropped ${dropped} non-public URL(s) from batch`,
        );
      }
      if (!allowed.length) {
        return { result: 'rejected', reason: 'no public URLs in batch' };
      }
      const cookieCache = new Map<string, string | undefined>();
      const items = await Promise.all(
        // No interactive flag and no queue on batches — oxdm's triage
        // dialog owns both. See `OxdmClient.batch`.
        allowed.map((i) => enrich(i, { handoff: false, cookieCache })),
      );
      return client.batch(items);
    }
    case 'connection-status':
      return { state: client.getState() };
    case 'list-queues':
      return { queues: await client.listQueues() };
    case 'menu-state':
      await applyMenuState(msg.selection, msg.page);
      return { ok: true };
    case 'get-logs':
      return { logs: await getLogs() };
    case 'clear-logs':
      await clearLogs();
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
  // Not gated on auto-capture: an explicit right-click is the user
  // asking for this one download, which is exactly what someone who
  // turned interception off still wants.
  if (info.menuItemId !== 'oxdm-send') return;
  // Single item across all contexts — decide intent from info shape.
  if (info.linkUrl) {
    if (!isPublicHttpUrl(info.linkUrl)) {
      notify('oxdm', `Refused non-public URL: ${info.linkUrl}`);
      return;
    }
    await client.capture(await buildCapture(info.linkUrl, tab));
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
  return enrich({ url, referrer: tab?.url, ...(extras ?? {}) });
}

interface EnrichOpts {
  /**
   * Apply the user's handoff preference (`interactive` + queue).
   * Off for batches, which are always triaged by oxdm's own dialog.
   */
  handoff?: boolean;
  /** Shared per-origin cookie memo, for batches that hit one host. */
  cookieCache?: Map<string, string | undefined>;
}

/**
 * Fill in the fields only the background can supply: the cookie jar
 * and real User-Agent (a content script can read neither), plus the
 * user's handoff preference.
 *
 * Everything *after* the handoff — filename resolution, save folder,
 * category, segments, dedup — is oxdm's job and is deliberately not
 * decided or duplicated here.
 */
async function enrich(
  req: CaptureRequest,
  opts: EnrichOpts = {},
): Promise<CaptureRequest> {
  const { handoff = true, cookieCache } = opts;
  const out: CaptureRequest = { ...req };
  if (out.cookies === undefined) {
    out.cookies = await readCookieHeader(out.url, cookieCache);
  }
  if (out.user_agent === undefined) out.user_agent = navigator.userAgent;
  if (handoff) {
    out.interactive = settings.interactive;
    // A queue is only ours to choose when no dialog opens. oxdm's Add
    // dialog already has a queue picker, prefilled from the file's
    // category, so sending one would silently override the user's
    // own routing rules at the exact moment they can see them.
    if (!settings.interactive && settings.defaultQueue) {
      out.queue = settings.defaultQueue;
    }
  }
  return out;
}

async function readCookieHeader(
  url: string,
  cache?: Map<string, string | undefined>,
): Promise<string | undefined> {
  // Cookies are scoped per origin, so a batch drawn from one page
  // resolves with a single jar read instead of one per link.
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  if (cache?.has(origin)) return cache.get(origin);
  let header: string | undefined;
  try {
    const list = await browser.cookies.getAll({ url });
    header = list.length
      ? list.map((c) => `${c.name}=${c.value}`).join('; ')
      : undefined;
  } catch {
    header = undefined;
  }
  cache?.set(origin, header);
  return header;
}

async function onDownloadCreated(item: any) {
  if (!settings.autoCapture) return;
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

  const req = await enrich({
    url: item.url,
    filename: item.filename ? item.filename.split(/[\\/]/).pop() : undefined,
    referrer: item.referrer || undefined,
    mime_type: item.mime || undefined,
    size: item.fileSize > 0 ? item.fileSize : undefined,
  });
  const r = await client.capture(req);
  if (r.result === 'rejected') {
    void pushLog('warn', 'capture', `rejected: ${r.reason} (${item.url})`);
    notify('oxdm rejected download', r.reason);
  }
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
