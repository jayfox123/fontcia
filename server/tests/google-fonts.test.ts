import { describe, it, expect } from 'vitest';
import { extractFontFileUrl, mimeTypeForFontUrl } from '../src/lib/google-fonts';

describe('extractFontFileUrl', () => {
  it('extracts the font file URL from a realistic Google Fonts CSS2 response', () => {
    const css = `
      /* latin */
      @font-face {
        font-family: 'Inter';
        font-style: normal;
        font-weight: 400;
        src: url(https://fonts.gstatic.com/s/inter/v13/abc123.woff2) format('woff2');
      }
    `;
    expect(extractFontFileUrl(css)).toBe('https://fonts.gstatic.com/s/inter/v13/abc123.woff2');
  });

  it('returns null when no font-face src is found', () => {
    expect(extractFontFileUrl('not valid css')).toBeNull();
  });
});

describe('mimeTypeForFontUrl', () => {
  it('maps common gstatic file extensions to their MIME types', () => {
    expect(mimeTypeForFontUrl('https://fonts.gstatic.com/s/inter/v13/abc123.woff2')).toBe('font/woff2');
    expect(mimeTypeForFontUrl('https://fonts.gstatic.com/s/roboto/v30/abc123.ttf')).toBe('font/ttf');
    expect(mimeTypeForFontUrl('https://fonts.gstatic.com/s/lato/v24/abc123.woff')).toBe('font/woff');
    expect(mimeTypeForFontUrl('https://fonts.gstatic.com/s/lato/v24/abc123.otf')).toBe('font/otf');
  });

  it('falls back to a generic binary MIME type for an unrecognized extension', () => {
    expect(mimeTypeForFontUrl('https://fonts.gstatic.com/s/lato/v24/abc123.eot')).toBe('application/octet-stream');
  });
});
