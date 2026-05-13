// Mirror of oxdm's encode_pairing_code / decode_pairing_code helpers
// (src/data/state.rs). Canonical form:
//
//     oxdm1.<base64url(port_be_u16 || 32_token_bytes)>
//
// Fallback form (when the stored token isn't a 32-byte base64url
// string) packs the token as its raw display string. Both round-trip
// through decode().

const PREFIX = 'oxdm1.';

export function decodePairingCode(code: string): { port: number; token: string } | null {
  const rest = code.trim();
  if (!rest.startsWith(PREFIX)) return null;
  const body = rest.slice(PREFIX.length);
  let raw: Uint8Array;
  try {
    raw = base64urlDecode(body);
  } catch {
    return null;
  }
  if (raw.length < 3) return null;
  const port = (raw[0] << 8) | raw[1];
  if (raw.length === 34) {
    const token = base64urlEncode(raw.slice(2));
    return { port, token };
  }
  // Fallback form — token segment is the original base64url string.
  const token = new TextDecoder().decode(raw.slice(2));
  return { port, token };
}

export function encodePairingCode(port: number, token: string): string {
  // Try canonical (32-byte token) form first; fall back to packing the
  // string verbatim so weird tokens still round-trip.
  try {
    const tokenBytes = base64urlDecode(token);
    if (tokenBytes.length === 32) {
      const buf = new Uint8Array(34);
      buf[0] = (port >> 8) & 0xff;
      buf[1] = port & 0xff;
      buf.set(tokenBytes, 2);
      return PREFIX + base64urlEncode(buf);
    }
  } catch {
    // fall through to fallback
  }
  const tokenAscii = new TextEncoder().encode(token);
  const buf = new Uint8Array(2 + tokenAscii.length);
  buf[0] = (port >> 8) & 0xff;
  buf[1] = port & 0xff;
  buf.set(tokenAscii, 2);
  return PREFIX + base64urlEncode(buf);
}

function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
