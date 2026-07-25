export function extractFontFileUrl(css2ResponseText: string): string | null {
  const match = css2ResponseText.match(/src: url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
  return match ? match[1] : null;
}

// The one function in this file that touches the real network — fetches a
// font's CSS from Google Fonts, then fetches the actual font file it points
// at, and returns it as a data URL a browser page's @font-face rule can load
// directly with no separate static file server. Not unit-tested: it's a thin
// network-glue wrapper around extractFontFileUrl (which IS tested above),
// verified for real by actually running build-reference-set.ts (this task's
// own later step) and evaluate-matching.ts (a later task).
export async function fetchGoogleFontDataUrl(fontName: string): Promise<string> {
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}&display=swap`);
  const css = await cssRes.text();

  const fontFileUrl = extractFontFileUrl(css);
  if (!fontFileUrl) {
    throw new Error(`Could not find a font file URL for "${fontName}" in the Google Fonts CSS response`);
  }

  const fontRes = await fetch(fontFileUrl);
  const fontBuffer = Buffer.from(await fontRes.arrayBuffer());
  return `data:font/woff2;base64,${fontBuffer.toString('base64')}`;
}
