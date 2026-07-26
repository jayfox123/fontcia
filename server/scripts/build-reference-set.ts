import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { fetchGoogleFontDataUrl } from '../src/lib/google-fonts';
import { toVectorLiteral } from '../src/lib/vector-format';
import { getEmbedding } from '../src/lib/embedding-client';
import { renderFontSample } from './lib/render-font-sample';

interface FontEntry {
  name: string;
}

const BUILD_PHRASE = 'The quick brown fox jumps over the lazy dog';

async function main(): Promise<void> {
  const fonts: FontEntry[] = JSON.parse(readFileSync(resolve(__dirname, 'fonts.json'), 'utf-8'));
  let browser = await puppeteer.launch();

  let succeeded = 0;
  let failed = 0;

  for (const [index, font] of fonts.entries()) {
    console.log(`[${index + 1}/${fonts.length}] ${font.name}`);
    try {
      // Chromium can crash outright after enough sequential page renders in
      // one long-lived instance (observed after ~75 fonts on this pipeline).
      // Relaunching on disconnect keeps one bad font's browser crash from
      // taking out the rest of the run.
      if (!browser.connected) {
        console.log('  Browser disconnected, relaunching...');
        browser = await puppeteer.launch();
      }

      const dataUrl = await fetchGoogleFontDataUrl(font.name);
      const image = await renderFontSample(browser, dataUrl, BUILD_PHRASE);
      const embedding = await getEmbedding(image);

      const fontRow = await prisma.font.upsert({
        where: { name: font.name },
        create: { name: font.name, googleSlug: font.name, category: null },
        update: {},
      });

      const vectorLiteral = toVectorLiteral(embedding);
      await prisma.$executeRaw`
        INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
        VALUES (${randomUUID()}, ${fontRow.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
        ON CONFLICT ("fontId", "renderVariant") DO UPDATE SET embedding = EXCLUDED.embedding
      `;
      succeeded++;
    } catch (error) {
      failed++;
      console.error(`  Failed: ${font.name}`, error);
    }
  }

  if (browser.connected) {
    await browser.close();
  }
  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed out of ${fonts.length}.`);
}

main().catch((error) => {
  console.error('build-reference-set failed:', error);
  process.exit(1);
});
