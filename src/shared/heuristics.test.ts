import { describe, expect, it } from 'vitest';
import { extOf, isDownloadishUrl, isPublicHttpUrl, extractUrls } from './heuristics';

describe('extOf', () => {
  it('returns lower-case extension', () => {
    expect(extOf('https://example.com/foo.ZIP')).toBe('zip');
    expect(extOf('https://example.com/a/b.mkv?token=x')).toBe('mkv');
  });
  it('rejects long / non-alnum tails', () => {
    expect(extOf('https://example.com/page')).toBeNull();
    expect(extOf('https://example.com/page.html5player')).toBeNull();
    expect(extOf('https://example.com/file.tar.gz')).toBe('gz');
  });
});

describe('isDownloadishUrl', () => {
  it('matches known media + archive extensions', () => {
    expect(isDownloadishUrl('https://x/y.mkv')).toBe(true);
    expect(isDownloadishUrl('https://x/y.7z')).toBe(true);
    expect(isDownloadishUrl('https://x/y.pdf')).toBe(true);
  });
  it('matches dynamic download patterns', () => {
    expect(isDownloadishUrl('https://x/serve?download=1')).toBe(true);
    expect(isDownloadishUrl('https://x/download/123')).toBe(true);
  });
  it('rejects html pages', () => {
    expect(isDownloadishUrl('https://x/page.html')).toBe(false);
    expect(isDownloadishUrl('https://x/page')).toBe(false);
  });
});

describe('isPublicHttpUrl', () => {
  it('accepts plain public http(s)', () => {
    expect(isPublicHttpUrl('https://example.com/a.zip')).toBe(true);
    expect(isPublicHttpUrl('http://1.1.1.1/a.zip')).toBe(true);
  });
  it('rejects non-http schemes', () => {
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isPublicHttpUrl('ftp://x/y')).toBe(false);
    expect(isPublicHttpUrl('magnet:?xt=urn:btih:abc')).toBe(false);
  });
  it('rejects loopback + RFC1918 + link-local', () => {
    expect(isPublicHttpUrl('http://localhost/x')).toBe(false);
    expect(isPublicHttpUrl('http://127.0.0.1/x')).toBe(false);
    expect(isPublicHttpUrl('http://10.0.0.5/x')).toBe(false);
    expect(isPublicHttpUrl('http://192.168.1.1/x')).toBe(false);
    expect(isPublicHttpUrl('http://172.16.0.1/x')).toBe(false);
    expect(isPublicHttpUrl('http://169.254.1.1/x')).toBe(false);
    expect(isPublicHttpUrl('http://100.64.0.1/x')).toBe(false);
    expect(isPublicHttpUrl('http://[::1]/x')).toBe(false);
    expect(isPublicHttpUrl('http://[fe80::1]/x')).toBe(false);
    expect(isPublicHttpUrl('http://[fd00::1]/x')).toBe(false);
  });
  it('rejects mixed-public boundary', () => {
    expect(isPublicHttpUrl('http://172.32.0.1/x')).toBe(true);
    expect(isPublicHttpUrl('http://100.128.0.1/x')).toBe(true);
  });
});

describe('extractUrls', () => {
  it('finds plain URLs', () => {
    const text = 'see https://a.com/x.zip and http://b/y.mp4 cool';
    expect(extractUrls(text)).toEqual([
      'https://a.com/x.zip',
      'http://b/y.mp4',
    ]);
  });
  it('strips trailing punctuation', () => {
    expect(extractUrls('grab https://x/y.zip.')).toEqual(['https://x/y.zip']);
    expect(extractUrls('(https://x/y.zip)')).toEqual(['https://x/y.zip']);
  });
  it('handles magnet links', () => {
    expect(extractUrls('magnet:?xt=urn:btih:abc on tracker')).toEqual([
      'magnet:?xt=urn:btih:abc',
    ]);
  });
});
