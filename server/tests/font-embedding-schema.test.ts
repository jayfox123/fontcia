import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
});

describe('Font / FontEmbedding schema', () => {
  it('stores and retrieves a vector via raw SQL, and cosine distance to itself is ~0', async () => {
    const font = await prisma.font.create({
      data: { name: 'Test Font', googleSlug: 'Test Font', category: 'sans-serif' },
    });

    const embeddingId = randomUUID();
    const vectorLiteral = `[${Array.from({ length: 384 }, (_, i) => i / 384).join(',')}]`;

    await prisma.$executeRaw`
      INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
      VALUES (${embeddingId}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
    `;

    const result = await prisma.$queryRaw<Array<{ distance: number }>>`
      SELECT embedding <=> ${vectorLiteral}::vector AS distance
      FROM "FontEmbedding"
      WHERE id = ${embeddingId}
    `;

    expect(result).toHaveLength(1);
    expect(result[0].distance).toBeCloseTo(0, 5);
  });

  it('enforces one embedding per (font, renderVariant)', async () => {
    const font = await prisma.font.create({
      data: { name: 'Duplicate Test Font', googleSlug: 'Duplicate Test Font' },
    });
    const vectorLiteral = `[${Array.from({ length: 384 }, () => 0).join(',')}]`;

    await prisma.$executeRaw`
      INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
      VALUES (${randomUUID()}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
    `;

    await expect(
      prisma.$executeRaw`
        INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
        VALUES (${randomUUID()}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
      `,
    ).rejects.toThrow();
  });
});
