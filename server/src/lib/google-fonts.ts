export function extractFontFileUrl(css2ResponseText: string): string | null {
  const match = css2ResponseText.match(/src: url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
  return match ? match[1] : null;
}

// Google's CSS2 endpoint serves different font formats (woff2, ttf, ...)
// depending on the request's User-Agent, and Node's default fetch doesn't
// look like a modern browser to it — so the format actually returned can't
// be assumed to be woff2. The gstatic file URL's own extension reliably
// matches its real format, so derive the MIME type from that instead of
// hardcoding one.
export function mimeTypeForFontUrl(fontFileUrl: string): string {
  if (fontFileUrl.endsWith('.woff2')) return 'font/woff2';
  if (fontFileUrl.endsWith('.woff')) return 'font/woff';
  if (fontFileUrl.endsWith('.ttf')) return 'font/ttf';
  if (fontFileUrl.endsWith('.otf')) return 'font/otf';
  return 'application/octet-stream';
}

// The one function in this file that touches the real network — fetches a
// font's CSS from Google Fonts, then fetches the actual font file it points
// at, and returns it as a data URL a browser page's @font-face rule can load
// directly with no separate static file server. Not unit-tested: it's a thin
// network-glue wrapper around extractFontFileUrl/mimeTypeForFontUrl (which
// ARE tested above), verified for real by actually running
// build-reference-set.ts (this task's own later step) and
// evaluate-matching.ts (a later task).
export async function fetchGoogleFontDataUrl(fontName: string): Promise<string> {
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}&display=swap`);
  const css = await cssRes.text();

  const fontFileUrl = extractFontFileUrl(css);
  if (!fontFileUrl) {
    throw new Error(`Could not find a font file URL for "${fontName}" in the Google Fonts CSS response`);
  }

  const fontRes = await fetch(fontFileUrl);
  const fontBuffer = Buffer.from(await fontRes.arrayBuffer());
  return `data:${mimeTypeForFontUrl(fontFileUrl)};base64,${fontBuffer.toString('base64')}`;
}
