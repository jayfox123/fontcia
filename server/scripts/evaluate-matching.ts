import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchGoogleFontDataUrl } from '../src/lib/google-fonts';
import { renderFontSample } from './lib/render-font-sample';

interface FontEntry {
  name: string;
}

const EVAL_PHRASE = 'Pack my box with five dozen liquor jugs';
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001';

async function matchFont(imageBuffer: Buffer): Promise<string[]> {
  const formData = new FormData();
  formData.append('image', new Blob([imageBuffer]), 'eval.png');

  const res = await fetch(`${SERVER_URL}/font-matches`, { method: 'POST', body: formData });
  if (!res.ok) {
    throw new Error(`/font-matches returned ${res.status}`);
  }
  const body = (await res.json()) as { matches: Array<{ fontName: string }> };
  return body.matches.map((m) => m.fontName);
}

async function main(): Promise<void> {
  const fonts: FontEntry[] = JSON.parse(readFileSync(resolve(__dirname, 'fonts.json'), 'utf-8'));
  const browser = await puppeteer.launch();

  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let errors = 0;

  for (const [index, font] of fonts.entries()) {
    try {
      const dataUrl = await fetchGoogleFontDataUrl(font.name);
      const image = await renderFontSample(browser, dataUrl, EVAL_PHRASE);
      const results = await matchFont(image);

      const rank = results.indexOf(font.name);
      if (rank === 0) top1++;
      if (rank !== -1 && rank < 3) top3++;
      if (rank !== -1 && rank < 5) top5++;

      console.log(
        `[${index + 1}/${fonts.length}] ${font.name}: top result "${results[0] ?? 'none'}" ${rank === 0 ? '✓' : '✗'}`,
      );
    } catch (error) {
      errors++;
      console.error(`  Error evaluating ${font.name}:`, error);
    }
  }

  await browser.close();

  const total = fonts.length;
  console.log('\n--- Evaluation results ---');
  console.log(`Total fonts evaluated: ${total} (${errors} errors)`);
  console.log(`Top-1 accuracy: ${top1}/${total} (${((top1 / total) * 100).toFixed(1)}%)`);
  console.log(`Top-3 accuracy: ${top3}/${total} (${((top3 / total) * 100).toFixed(1)}%)`);
  console.log(`Top-5 accuracy: ${top5}/${total} (${((top5 / total) * 100).toFixed(1)}%)`);
}

main().catch((error) => {
  console.error('evaluate-matching failed:', error);
  process.exit(1);
});
