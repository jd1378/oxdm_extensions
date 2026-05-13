import { describe, expect, it } from 'vitest';
import { encodePairingCode, decodePairingCode } from './pairing';

describe('pairing code', () => {
  it('round-trips canonical 32-byte token form', () => {
    // 32 raw bytes → base64url
    const raw = new Uint8Array(32).map((_, i) => i + 1);
    let s = '';
    for (const b of raw) s += String.fromCharCode(b);
    const token = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const code = encodePairingCode(27812, token);
    expect(code.startsWith('oxdm1.')).toBe(true);
    const decoded = decodePairingCode(code);
    expect(decoded).toEqual({ port: 27812, token });
  });

  it('round-trips fallback non-32-byte token form', () => {
    const token = 'short-token-not-32-bytes';
    const code = encodePairingCode(1234, token);
    expect(decodePairingCode(code)).toEqual({ port: 1234, token });
  });

  it('rejects garbage', () => {
    expect(decodePairingCode('not-a-pairing-code')).toBeNull();
    expect(decodePairingCode('oxdm1.!!!!')).toBeNull();
    expect(decodePairingCode('oxdm1.AA')).toBeNull(); // <3 bytes
  });
});
