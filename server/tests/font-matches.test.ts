import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

vi.mock('../src/lib/embedding-client', () => ({
  getEmbedding: vi.fn(),
}));

import { getEmbedding } from '../src/lib/embedding-client';

async function seedFontEmbedding(fontName: string, embedding: number[]): Promise<void> {
  const font = await prisma.font.create({ data: { name: fontName, googleSlug: fontName, category: 'sans-serif' } });
  const vectorLiteral = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`
    INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
    VALUES (${randomUUID()}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
  `;
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(getEmbedding).mockReset();
});

describe('POST /font-matches', () => {
  it('rejects a request with no image', async () => {
    const res = await request(app).post('/font-matches');
    expect(res.status).toBe(400);
  });

  it('returns the closest font first, with confidence near 100 for an exact match', async () => {
    const queryEmbedding = Array.from({ length: 384 }, () => 1);
    const farEmbedding = Array.from({ length: 384 }, () => -1);

    await seedFontEmbedding('Exact Match Font', queryEmbedding);
    await seedFontEmbedding('Far Font', farEmbedding);

    vi.mocked(getEmbedding).mockResolvedValueOnce(queryEmbedding);

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches[0].fontName).toBe('Exact Match Font');
    expect(res.body.matches[0].confidence).toBeGreaterThanOrEqual(99);
    expect(res.body.matches[0].sources[0]).toEqual({
      url: 'https://fonts.google.com/specimen/Exact+Match+Font',
      label: 'Google Fonts',
      votes: 1,
    });
  });

  it('returns an empty matches array when no reference embeddings exist', async () => {
    vi.mocked(getEmbedding).mockResolvedValueOnce(Array.from({ length: 384 }, () => 0));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches).toEqual([]);
  });

  it('returns at most 5 matches even when more reference fonts exist', async () => {
    // Constant-value vectors are all mutually parallel (cosine distance 0
    // or 2 between any two), which collapses the margin between candidates
    // to 0 and would trip the "no clear winner" rejection below. Flipping a
    // growing prefix of dimensions gives each font a genuinely different
    // direction, with large, well-separated distances from the query.
    function embeddingWithFlippedPrefix(flipCount: number): number[] {
      return Array.from({ length: 384 }, (_, idx) => (idx < flipCount ? -1 : 1));
    }

    for (let i = 0; i < 7; i++) {
      await seedFontEmbedding(`Font ${i}`, embeddingWithFlippedPrefix((i + 1) * 20));
    }
    vi.mocked(getEmbedding).mockResolvedValueOnce(embeddingWithFlippedPrefix(0));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches).toHaveLength(5);
  });

  it('returns no matches when the top two candidates are too close to call', async () => {
    const queryEmbedding = Array.from({ length: 384 }, () => 1);
    // Two fonts an equal, tiny distance from the query and from each other
    // — nothing stands out as a clear winner.
    const almostIdenticalA = Array.from({ length: 384 }, (_, idx) => (idx === 0 ? 0.999 : 1));
    const almostIdenticalB = Array.from({ length: 384 }, (_, idx) => (idx === 1 ? 0.999 : 1));

    await seedFontEmbedding('Ambiguous Font A', almostIdenticalA);
    await seedFontEmbedding('Ambiguous Font B', almostIdenticalB);

    vi.mocked(getEmbedding).mockResolvedValueOnce(queryEmbedding);

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches).toEqual([]);
  });

  it('returns a 500 without crashing when the embedding service call fails', async () => {
    vi.mocked(getEmbedding).mockRejectedValueOnce(new Error('embedding service unreachable'));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(500);
  });

  it('rejects an upload larger than the size limit with a 400, not a 500', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1);

    const res = await request(app).post('/font-matches').attach('image', oversized, 'huge.png');

    expect(res.status).toBe(400);
    expect(getEmbedding).not.toHaveBeenCalled();
  });
});
