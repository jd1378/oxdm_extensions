// Heuristics: does this URL / element look like a downloadable file?

const ARCHIVE = ['zip','rar','7z','tar','gz','tgz','bz2','xz','zst','lz','lzma','cab','iso','dmg','pkg','deb','rpm','apk','xpi','msi','exe','appimage','jar','war'];
const MEDIA = ['mp4','mkv','avi','mov','webm','flv','wmv','mpg','mpeg','m4v','ts','mp3','flac','wav','aac','ogg','opus','m4a','wma','aif','aiff'];
const DOC = ['pdf','epub','mobi','azw3','djvu','cbr','cbz'];
const IMG_HUGE = ['psd','tif','tiff','raw','cr2','nef','arw','dng'];
const OTHER = ['torrent'];

export const DOWNLOAD_EXTS = new Set<string>([
  ...ARCHIVE, ...MEDIA, ...DOC, ...IMG_HUGE, ...OTHER,
]);

export function extOf(urlStr: string): string | null {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const u = new URL(urlStr, base);
    const path = u.pathname;
    const dot = path.lastIndexOf('.');
    if (dot < 0) return null;
    const e = path.slice(dot + 1).toLowerCase();
    if (e.length < 1 || e.length > 8) return null;
    if (!/^[a-z0-9]+$/.test(e)) return null;
    return e;
  } catch {
    return null;
  }
}

export function isDownloadishUrl(urlStr: string): boolean {
  if (!isPublicHttpUrl(urlStr)) return false;
  const e = extOf(urlStr);
  if (e && DOWNLOAD_EXTS.has(e)) return true;
  if (/[?&](attachment|download|dl|file)=/i.test(urlStr)) return true;
  if (/\/(download|attachment|file)s?\//i.test(urlStr)) return true;
  return false;
}

/**
 * Mirror of oxdm's `ipc::guard_public_http_url`. Reject non-http(s)
 * schemes plus any host that is loopback / private / link-local. We
 * apply this on the extension side so a malicious selection on
 * attacker.com cannot trick the user into pointing oxdm at internal
 * infrastructure (router admin panels, intranet pages, localhost
 * services). The daemon repeats the same check — both sides defend
 * defence-in-depth.
 */
export function isPublicHttpUrl(urlStr: string): boolean {
  let u: URL;
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    u = new URL(urlStr, base);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  let host = u.hostname.toLowerCase();
  // Some runtimes return IPv6 literals with their surrounding brackets.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isIpv4Literal(host)) return !isPrivateIpv4(host);
  if (host.includes(':')) return !isPrivateIpv6(host);
  return true;
}

function isIpv4Literal(h: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

function isPrivateIpv4(h: string): boolean {
  const o = h.split('.').map((n) => parseInt(n, 10));
  if (o.some((n) => isNaN(n) || n < 0 || n > 255)) return true;
  // 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10 (CGNAT),
  // 0/8 unspecified, 224/4 multicast, 240/4 reserved, 255 broadcast.
  if (o[0] === 10) return true;
  if (o[0] === 127) return true;
  if (o[0] === 0) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && (o[1] & 0xc0) === 0x40) return true;
  if (o[0] >= 224) return true;
  return false;
}

function isPrivateIpv6(h: string): boolean {
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
    return true;
  // fc00::/7 ULA.
  const first = h.split(':')[0] || '';
  const hi = parseInt(first.padStart(4, '0').slice(0, 2), 16);
  if (!isNaN(hi) && (hi & 0xfe) === 0xfc) return true;
  if (h.startsWith('ff')) return true; // multicast
  return false;
}

export function isDownloadishElement(el: Element): boolean {
  if (el instanceof HTMLAnchorElement) {
    if (el.hasAttribute('download')) return true;
    if (el.href && isDownloadishUrl(el.href)) return true;
  }
  const txt = (el.textContent ?? '').trim().toLowerCase();
  if (txt.length > 0 && txt.length < 40) {
    if (/^(download|get|grab|save|télécharger|descargar)\b/.test(txt)) {
      // only count if the element resolves to an anchor or has href-like attrs
      const a = el.closest('a');
      if (a && a.href) return true;
    }
  }
  return false;
}

// URL extraction from arbitrary text — selection drop, clipboard, etc.
const URL_RE =
  /\b(?:https?:\/\/|ftp:\/\/|magnet:\?)[^\s<>"']+/gi;

export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  const m = text.match(URL_RE);
  if (m) for (const s of m) out.add(stripTrailingPunct(s));
  return [...out];
}

function stripTrailingPunct(s: string) {
  return s.replace(/[)\].,;:!?'"]+$/g, '');
}

/**
 * URLs the user "selected": union of
 *   - URLs textually present in the selection (a pasted-as-text link),
 *   - hrefs of anchors whose DOM nodes intersect the selection range
 *     (the link sits inside the highlighted span — common when
 *     dragging across a list of download buttons).
 *
 * Filtered through `isPublicHttpUrl` so loopback / RFC1918 / non-http
 * never reach oxdm via the selection path.
 */
export function urlsFromSelection(sel: Selection): string[] {
  const out = new Set<string>();
  const text = sel.toString();
  if (text.length >= 4 && text.length <= 50_000) {
    for (const u of extractUrls(text)) {
      if (isPublicHttpUrl(u)) out.add(u);
    }
  }
  // Walk every range; for each anchor in the document, include its
  // href when any range intersects the anchor's node. Cheap because
  // anchor counts are bounded by page size.
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
  if (anchors.length) {
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      for (const a of anchors) {
        if (!a.href) continue;
        if (!r.intersectsNode(a)) continue;
        if (isPublicHttpUrl(a.href)) out.add(a.href);
      }
    }
  }
  return [...out];
}
