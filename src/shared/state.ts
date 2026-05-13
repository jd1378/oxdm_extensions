// Persisted extension settings. storage.sync where available, fallback to local.

import { decodePairingCode } from './pairing';

export type Transport = 'auto' | 'native' | 'ws';

export interface Settings {
  enabled: boolean;
  /** Transport selection. 'auto' tries native first then falls back to WS. */
  transport: Transport;
  /** Native-messaging host id. Must match the installed manifest's `name`. */
  nativeHostName: string;
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
  minSize: number; // bytes; below this, browser handles it
  skipDomains: string[];
  skipExtensions: string[]; // lower-case, no dot
  skipMimePrefixes: string[]; // e.g. "text/html"
  injectButton: boolean;
  scanIntervalMs: number;
}

export const DEFAULTS: Settings = {
  enabled: true,
  transport: 'auto',
  nativeHostName: 'io.github.jd1378.oxdm.host',
  pairingCode: '',
  port: 27812,
  token: '',
  minSize: 0,
  skipDomains: [],
  skipExtensions: ['html', 'htm', 'php', 'asp', 'aspx', 'jsp'],
  skipMimePrefixes: ['text/html', 'application/xhtml'],
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
