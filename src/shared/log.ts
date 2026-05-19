// Rolling log buffer surfaced in the Options page so users can see
// *why* a connection attempt failed without opening devtools.
//
// Persisted in `browser.storage.local` (single key, capped array) so
// entries survive MV3 service-worker restarts. The Options page also
// subscribes to `storage.onChanged` to keep the panel live.

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Unix ms. */
  ts: number;
  level: LogLevel;
  /** Short tag identifying the subsystem (e.g. `ipc`, `capture`). */
  source: string;
  message: string;
}

const KEY = 'oxdm:logs';
const CAP = 100;

export async function pushLog(
  level: LogLevel,
  source: string,
  message: string,
): Promise<void> {
  try {
    const got = await browser.storage.local.get(KEY);
    const cur = (got[KEY] as LogEntry[] | undefined) ?? [];
    cur.push({ ts: Date.now(), level, source, message });
    while (cur.length > CAP) cur.shift();
    await browser.storage.local.set({ [KEY]: cur });
  } catch {
    // Storage write failed (quota, transient SW shutdown). Drop the
    // entry — losing a log line is preferable to throwing into the
    // error path that produced it.
  }
}

export async function getLogs(): Promise<LogEntry[]> {
  const got = await browser.storage.local.get(KEY);
  return (got[KEY] as LogEntry[] | undefined) ?? [];
}

export async function clearLogs(): Promise<void> {
  await browser.storage.local.set({ [KEY]: [] });
}

export function onLogsChange(cb: (logs: LogEntry[]) => void) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(KEY in changes)) return;
    cb((changes[KEY].newValue as LogEntry[] | undefined) ?? []);
  });
}
