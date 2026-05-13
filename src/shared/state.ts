// Persisted extension settings. storage.sync where available, fallback to local.

export interface Settings {
  enabled: boolean;
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
