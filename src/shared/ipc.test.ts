import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildNativeErrorReason } from './ipc';

const NOT_FOUND = 'Specified native messaging host not found.';
const EXITED = 'Native host has exited.';

function withUserAgent(ua: string | undefined, fn: () => void) {
  vi.stubGlobal('navigator', ua === undefined ? undefined : { userAgent: ua });
  try {
    fn();
  } finally {
    vi.unstubAllGlobals();
  }
}

const UA = {
  linux: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
};

describe('buildNativeErrorReason', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the manifest location for the platform in use', () => {
    withUserAgent(UA.mac, () => {
      const out = buildNativeErrorReason(NOT_FOUND);
      expect(out).toContain('Library/Application Support');
      expect(out).not.toContain('~/.config/');
    });
    withUserAgent(UA.win, () => {
      const out = buildNativeErrorReason(NOT_FOUND);
      expect(out).toContain('HKCU\\Software');
      expect(out).not.toContain('~/.config/');
    });
    withUserAgent(UA.linux, () => {
      expect(buildNativeErrorReason(NOT_FOUND)).toContain('~/.config/');
    });
  });

  it('falls back to every platform when the agent says nothing', () => {
    withUserAgent('', () => {
      const out = buildNativeErrorReason(NOT_FOUND);
      for (const label of ['Linux:', 'macOS:', 'Windows:']) {
        expect(out).toContain(label);
      }
    });
  });

  it('points at oxdm itself, not the retired install script', () => {
    withUserAgent(UA.linux, () => {
      const out = buildNativeErrorReason(NOT_FOUND);
      expect(out).toContain('oxdm --install-native-host');
      expect(out).not.toContain('install-native-host.sh');
    });
  });

  it('gives the database location per platform when the host exits', () => {
    withUserAgent(UA.win, () => {
      expect(buildNativeErrorReason(EXITED)).toContain(
        '%APPDATA%\\oxdm\\db\\oxdm.db',
      );
    });
    withUserAgent(UA.linux, () => {
      expect(buildNativeErrorReason(EXITED)).toContain(
        '~/.local/share/oxdm/db/oxdm.db',
      );
    });
  });

  it('states the head line once', () => {
    withUserAgent(UA.linux, () => {
      const out = buildNativeErrorReason(NOT_FOUND);
      expect(out.split(NOT_FOUND).length - 1).toBe(1);
    });
  });
});
