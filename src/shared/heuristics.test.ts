import { describe, expect, it } from 'vitest';
import { extOf, isDownloadishUrl, extractUrls } from './heuristics';

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
