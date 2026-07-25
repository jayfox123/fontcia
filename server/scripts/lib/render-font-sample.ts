import type { Browser } from 'puppeteer';

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
