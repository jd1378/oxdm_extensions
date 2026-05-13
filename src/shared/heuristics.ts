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
  const e = extOf(urlStr);
  if (e && DOWNLOAD_EXTS.has(e)) return true;
  // common dynamic-download patterns
  if (/[?&](attachment|download|dl|file)=/i.test(urlStr)) return true;
  if (/\/(download|attachment|file)s?\//i.test(urlStr)) return true;
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
