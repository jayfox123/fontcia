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
// DINOv2's default image processor resizes the shortest edge to 256px, then
// center-crops a 224x224 square — destructive on a wide, short strip of
// text (most of the width gets cropped away). Rendering into a square
// container the text wraps and centers within, instead of a single wide
// line, keeps the whole sample inside that square crop.
const RENDER_SIZE = 320;

export async function renderFontSample(browser: Browser, fontDataUrl: string, text: string): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: RENDER_SIZE, height: RENDER_SIZE });
    await page.setContent(`
      <html>
        <head>
          <style>
            @font-face { font-family: 'SampleFont'; src: url('${fontDataUrl}'); }
            body { margin: 0; background: white; }
            #sample {
              width: ${RENDER_SIZE}px;
              height: ${RENDER_SIZE}px;
              display: flex;
              align-items: center;
              justify-content: center;
              text-align: center;
              font-family: 'SampleFont';
              font-size: 24px;
              color: black;
              box-sizing: border-box;
              padding: 16px;
            }
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
