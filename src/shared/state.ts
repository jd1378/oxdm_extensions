// Persisted extension settings. storage.sync where available, fallback to local.

import { decodePairingCode } from './pairing';

export type Transport = 'auto' | 'native' | 'ws';

/**
 * UX-only settings owned by the extension. Capture filters (min size,
 * skip lists, allow lists) are owned by oxdm and fetched at connect
 * time — see `CachedRules` below.
 */
export interface Settings {
  enabled: boolean;
  /** Transport selection. 'auto' tries native first then falls back to WS. */
  transport: Transport;
  /**
   * Single copy-pasteable pairing code from oxdm Settings → Browser
   * integration. Format: `oxdm1.<base64url>` bundling the IPC port +
   * extension token. Decoded by `decodePairingCode` into the legacy
   * `port` + `token` fields below at the moment we configure the
   * client.
   */
  pairingCode: string;
  port: number;
  token: string;
  injectButton: boolean;
  scanIntervalMs: number;
}

/**
 * Fixed, hardcoded native-messaging host id. Must match the installed
 * manifest's `name`. Not user-tunable: rebranding the host id would
 * require reinstalling the manifest anyway, so a setting is dead UI.
 */
export const NATIVE_HOST_NAME = 'io.github.jd1378.oxdm.host';

export const DEFAULTS: Settings = {
  enabled: true,
  transport: 'auto',
  pairingCode: '',
  port: 27812,
  token: '',
  injectButton: true,
  scanIntervalMs: 5000,
};

const KEY = 'oxdm:settings';

export async function getSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(KEY);
  const stored = (got[KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  // Whenever the pairing code changes, decode it into the legacy
  // port + token fields so the rest of the codebase keeps working.
  if (patch.pairingCode !== undefined) {
    const decoded = decodePairingCode(patch.pairingCode);
    if (decoded) {
      next.port = decoded.port;
      next.token = decoded.token;
    }
  }
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChange(cb: (s: Settings) => void) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(KEY in changes)) return;
    const next = { ...DEFAULTS, ...(changes[KEY].newValue ?? {}) };
    cb(next as Settings);
  });
}

// ── Capture rules, owned by oxdm ──────────────────────────────────────
// Fetched via `get_capture_rules` on connect, cached so the extension
// keeps working when oxdm briefly disconnects. The cache is rules-only
// (no user-facing UI); editing happens in oxdm.

export interface CaptureRules {
  minSize: number;
  skipDomains: string[];
  skipExtensions: string[];
  skipMimePrefixes: string[];
  allowExtensions: string[];
  allowMimePrefixes: string[];
}

// Conservative baked default: behaves like the pre-sync extension did
// (skip page-shaped URLs, no allowlist, no size threshold). Used only
// until the first successful sync from oxdm.
export const FALLBACK_RULES: CaptureRules = {
  minSize: 0,
  skipDomains: [],
  skipExtensions: ['html', 'htm', 'php', 'asp', 'aspx', 'jsp'],
  skipMimePrefixes: ['text/html', 'application/xhtml'],
  allowExtensions: [],
  allowMimePrefixes: [],
};

const RULES_KEY = 'oxdm:rules';

export async function getCachedRules(): Promise<CaptureRules> {
  const got = await browser.storage.local.get(RULES_KEY);
  const stored = got[RULES_KEY] as Partial<CaptureRules> | undefined;
  if (!stored) return FALLBACK_RULES;
  return { ...FALLBACK_RULES, ...stored };
}

export async function setCachedRules(r: CaptureRules): Promise<void> {
  await browser.storage.local.set({ [RULES_KEY]: r });
}
