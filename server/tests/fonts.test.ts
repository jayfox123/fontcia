import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
});

describe('GET /fonts/resolve', () => {
  it('finds a font by an exact matchKey', async () => {
    await prisma.font.create({
      data: {
        name: 'Brandon Grotesque',
        matchKeys: ['brandon grotesque'],
        sources: {
          create: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
        },
      },
    });

    const res = await request(app).get('/fonts/resolve').query({ name: 'Brandon Grotesque, sans-serif' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fontName: 'Brandon Grotesque',
      sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
    });
  });

  it('matches case-insensitively and ignores surrounding quotes', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });

    const res = await request(app).get('/fonts/resolve').query({ name: '"BRANDON GROTESQUE", sans-serif' });

    expect(res.status).toBe(200);
    expect(res.body.fontName).toBe('Brandon Grotesque');
  });

  it('checks every candidate in the stack, not just the first', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });

    const res = await request(app)
      .get('/fonts/resolve')
      .query({ name: 'SomeCustomAlias, Brandon Grotesque, sans-serif' });

    expect(res.status).toBe(200);
    expect(res.body.fontName).toBe('Brandon Grotesque');
  });

  it('prefers the first-listed candidate over a later one when both match different fonts', async () => {
    await prisma.font.create({ data: { name: 'Alias One Font', matchKeys: ['aliasone'] } });
    await prisma.font.create({ data: { name: 'Alias Two Font', matchKeys: ['aliastwo'] } });

    const res = await request(app).get('/fonts/resolve').query({ name: 'AliasOne, AliasTwo' });

    expect(res.status).toBe(200);
    expect(res.body.fontName).toBe('Alias One Font');
  });

  it('returns sources sorted by votes descending', async () => {
    await prisma.font.create({
      data: {
        name: 'Brandon Grotesque',
        matchKeys: ['brandon grotesque'],
        sources: {
          create: [
            { url: 'https://www.myfonts.com/fonts/brandon-grotesque', label: 'www.myfonts.com', votes: 1 },
            { url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 },
          ],
        },
      },
    });

    const res = await request(app).get('/fonts/resolve').query({ name: 'Brandon Grotesque' });

    expect(res.body.sources.map((s: { votes: number }) => s.votes)).toEqual([2, 1]);
  });

  it('returns 404 when no matchKey matches', async () => {
    const res = await request(app).get('/fonts/resolve').query({ name: 'SomeUnknownFont' });
    expect(res.status).toBe(404);
  });

  it('rejects a missing name query param', async () => {
    const res = await request(app).get('/fonts/resolve');
    expect(res.status).toBe(400);
  });

  it('does not require authentication', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });
    const res = await request(app).get('/fonts/resolve').query({ name: 'Brandon Grotesque' });
    expect(res.status).toBe(200);
  });
});
