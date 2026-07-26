import type { Browser } from 'puppeteer';

// This project doesn't include the DOM lib (its Node/fetch/Blob globals
// would otherwise collide with the DOM ones), but page.evaluate's callback
// below runs inside the browser page, not Node, where `document` is real.
// Declaring just the one property this file actually uses keeps that
// browser-context type local instead of pulling in all of DOM lib. If this
// file ever needs more of `document`, widen this declaration rather than
// adding "DOM" to lib or a `/// <reference lib="dom" />` — both reintroduce
// a Blob/BlobPart type collision with src/lib/embedding-client.ts.
declare const document: { fonts: { ready: Promise<unknown> } };

// Real-browser-only glue (Puppeteer) — not unit-tested, same treatment
// google-fonts.ts's fetchGoogleFontDataUrl got above. Verified by actually
// running build-reference-set.ts and evaluate-matching.ts.
export async function renderFontSample(browser: Browser, fontDataUrl: string, text: string): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 500, height: 120 });
    await page.setContent(`
      <html>
        <head>
          <style>
            @font-face { font-family: 'SampleFont'; src: url('${fontDataUrl}'); }
            body { margin: 0; padding: 10px; background: white; }
            #sample { font-family: 'SampleFont'; font-size: 32px; color: black; }
          </style>
        </head>
        <body><div id="sample">${text}</div></body>
      </html>
    `);
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$('#sample');
    if (!el) throw new Error('Sample element not found');
    return (await el.screenshot({ type: 'png' })) as Buffer;
  } finally {
    await page.close();
  }
}
