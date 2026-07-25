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
    for (let i = 0; i < 7; i++) {
      await seedFontEmbedding(`Font ${i}`, Array.from({ length: 384 }, () => i));
    }
    vi.mocked(getEmbedding).mockResolvedValueOnce(Array.from({ length: 384 }, () => 0));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches).toHaveLength(5);
  });

  it('returns a 500 without crashing when the embedding service call fails', async () => {
    vi.mocked(getEmbedding).mockRejectedValueOnce(new Error('embedding service unreachable'));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(500);
  });
});
