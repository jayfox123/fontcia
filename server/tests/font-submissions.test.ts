import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { signupRateLimit } from '../src/routes/auth';
import { resetDb } from './helpers/reset-db';

const TEST_CLIENT_IP = '::ffff:127.0.0.1';

async function signupUser(email: string): Promise<string> {
  const res = await request(app).post('/auth/signup').send({ email, password: 'password123' });
  return res.body.accessToken;
}

let submitterToken: string;

beforeEach(async () => {
  await resetDb();
  signupRateLimit.resetKey(TEST_CLIENT_IP);
  submitterToken = await signupUser('submitter@example.com');
});

describe('POST /font-submissions', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .field('fontName', 'Some Font')
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    expect(res.status).toBe(401);
  });

  it('creates a new pending submission with the sample image stored', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .field('sourceUrl', 'https://example.com/brandon-grotesque')
      .attach('image', Buffer.from('fake-image-bytes'), 'sample.png');

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');

    const stored = await prisma.fontSubmission.findUnique({ where: { id: res.body.submissionId } });
    expect(stored?.fontName).toBe('Brandon Grotesque');
    expect(stored?.sourceUrl).toBe('https://example.com/brandon-grotesque');
    expect(stored?.status).toBe('pending');
    expect(Buffer.from(stored?.sampleImage ?? []).toString()).toBe('fake-image-bytes');
  });

  it('rejects a request missing fontName', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    expect(res.status).toBe(400);
  });

  it('rejects an invalid sourceUrl instead of crashing', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Some Font')
      .field('sourceUrl', 'not-a-url')
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    expect(res.status).toBe(400);
  });

  it('rejects a request missing the image', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Some Font');
    expect(res.status).toBe(400);
  });

  it('rejects an upload larger than the size limit with a 400, not a 500', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1);
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Some Font')
      .attach('image', oversized, 'huge.png');
    expect(res.status).toBe(400);
  });

  it('treats a case-insensitive resubmission from a different user as a confirmation, not a duplicate', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    const secondRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerToken}`)
      .field('fontName', 'brandon grotesque')
      .attach('image', Buffer.from('a different scan'), 'sample.png');

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.submissionId).toBe(firstRes.body.submissionId);

    const allSubmissions = await prisma.fontSubmission.findMany();
    expect(allSubmissions).toHaveLength(1);

    const confirmations = await prisma.fontSubmissionConfirmation.findMany({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmations).toHaveLength(1);
  });

  it("stores a confirming resubmitter's own sourceUrl on their confirmation, without touching the original submission's sourceUrl", async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerToken}`)
      .field('fontName', 'Brandon Grotesque')
      .field('sourceUrl', 'https://example.com/brandon')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const stored = await prisma.fontSubmission.findUnique({ where: { id: firstRes.body.submissionId } });
    expect(stored?.sourceUrl).toBeNull();

    const confirmation = await prisma.fontSubmissionConfirmation.findFirst({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmation?.sourceUrl).toBe('https://example.com/brandon');
  });

  it('creates a findable Font row with deduped, correctly-voted FontSource rows on promotion', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .field('sourceUrl', 'https://fonts.adobe.com/fonts/brandon-grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`)
      .send({ sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque' });

    const confirmerBToken = await signupUser('confirmer-b@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`)
      .send({ sourceUrl: 'https://www.myfonts.com/fonts/brandon-grotesque' });

    const font = await prisma.font.findUnique({
      where: { name: 'Brandon Grotesque' },
      include: { sources: true },
    });
    expect(font).not.toBeNull();
    expect(font?.matchKeys).toEqual(['brandon grotesque']);
    expect(font?.sources).toHaveLength(2);

    const adobeSource = font?.sources.find((s) => s.url === 'https://fonts.adobe.com/fonts/brandon-grotesque');
    expect(adobeSource?.votes).toBe(2);
    expect(adobeSource?.label).toBe('fonts.adobe.com');

    const myFontsSource = font?.sources.find((s) => s.url === 'https://www.myfonts.com/fonts/brandon-grotesque');
    expect(myFontsSource?.votes).toBe(1);
    expect(myFontsSource?.label).toBe('www.myfonts.com');
  });

  it('promotes with zero FontSource rows when nobody proposed a sourceUrl', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`);

    const confirmerBToken = await signupUser('confirmer-b@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`);

    const font = await prisma.font.findUnique({ where: { name: 'Brandon Grotesque' }, include: { sources: true } });
    expect(font).not.toBeNull();
    expect(font?.sources).toHaveLength(0);
  });

  it('reuses an existing Font row case-insensitively rather than violating the unique name constraint', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });

    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'brandon grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`);
    const confirmerBToken = await signupUser('confirmer-b@example.com');
    const finalRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`);

    expect(finalRes.body.status).toBe('promoted');
    const fonts = await prisma.font.findMany({ where: { name: { equals: 'brandon grotesque', mode: 'insensitive' } } });
    expect(fonts).toHaveLength(1);
  });

  it('backfills matchKeys on a reused pre-existing Font row so it becomes resolvable after promotion', async () => {
    // Simulates a Font row seeded by the AI-catalog build script (server/scripts/build-reference-set.ts),
    // which never sets matchKeys, leaving it at the schema default of [].
    await prisma.font.create({ data: { name: 'Playfair Display', googleSlug: 'Playfair+Display' } });

    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'playfair display')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`);
    const confirmerBToken = await signupUser('confirmer-b@example.com');
    const finalRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`);

    expect(finalRes.body.status).toBe('promoted');

    const fonts = await prisma.font.findMany({ where: { name: { equals: 'playfair display', mode: 'insensitive' } } });
    expect(fonts).toHaveLength(1);
    expect(fonts[0].matchKeys).toEqual(['playfair display']);

    const resolveRes = await request(app).get('/fonts/resolve').query({ name: 'Playfair Display' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.fontName).toBe('Playfair Display');
  });

  it('resubmitting your own pending font name is a no-op, not a self-confirmation', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const secondRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.submissionId).toBe(firstRes.body.submissionId);

    const confirmations = await prisma.fontSubmissionConfirmation.findMany({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmations).toHaveLength(0);
  });

  it('auto-promotes once the submitter plus two independent confirmers agree', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerAToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    let stored = await prisma.fontSubmission.findUnique({ where: { id: firstRes.body.submissionId } });
    expect(stored?.status).toBe('pending');

    const confirmerBToken = await signupUser('confirmer-b@example.com');
    const thirdRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerBToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    expect(thirdRes.body.status).toBe('promoted');
    stored = await prisma.fontSubmission.findUnique({ where: { id: firstRes.body.submissionId } });
    expect(stored?.status).toBe('promoted');
  });
});

describe('GET /font-submissions/pending', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/font-submissions/pending');
    expect(res.status).toBe(401);
  });

  it('lists pending submissions with their confirmation counts', async () => {
    await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const res = await request(app).get('/font-submissions/pending').set('Authorization', `Bearer ${submitterToken}`);

    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(1);
    expect(res.body.submissions[0]).toEqual({
      id: expect.any(String),
      fontName: 'Brandon Grotesque',
      confirmationCount: 1,
    });
  });

  it('excludes promoted submissions', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    await prisma.fontSubmission.update({ where: { id: firstRes.body.submissionId }, data: { status: 'promoted' } });

    const res = await request(app).get('/font-submissions/pending').set('Authorization', `Bearer ${submitterToken}`);
    expect(res.body.submissions).toEqual([]);
  });
});

describe('POST /font-submissions/:id/confirm', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/font-submissions/does-not-matter/confirm');
    expect(res.status).toBe(401);
  });

  it('confirms a pending submission and increases its confirmation count', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    const confirmRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body).toEqual({ status: 'pending', confirmationCount: 2 });
  });

  it('rejects confirming your own submission', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const res = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${submitterToken}`);

    expect(res.status).toBe(400);
  });

  it('is idempotent: confirming the same submission twice does not double count', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);
    const secondConfirmRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);

    expect(secondConfirmRes.status).toBe(200);
    expect(secondConfirmRes.body.confirmationCount).toBe(2);
  });

  it('accepts an optional sourceUrl body and stores it on the confirmation', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`)
      .send({ sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque' });

    const confirmation = await prisma.fontSubmissionConfirmation.findFirst({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmation?.sourceUrl).toBe('https://fonts.adobe.com/fonts/brandon-grotesque');
  });

  it('rejects an invalid sourceUrl in the confirm body instead of crashing', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    const res = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`)
      .send({ sourceUrl: 'not-a-url' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for a submission that does not exist', async () => {
    const res = await request(app)
      .post('/font-submissions/00000000-0000-0000-0000-000000000000/confirm')
      .set('Authorization', `Bearer ${submitterToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a submission that has already been promoted', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    await prisma.fontSubmission.update({ where: { id: firstRes.body.submissionId }, data: { status: 'promoted' } });

    const confirmerToken = await signupUser('confirmer@example.com');
    const res = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);

    expect(res.status).toBe(404);
  });

  it('promotes once the threshold is reached via explicit confirmations', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`);

    const confirmerBToken = await signupUser('confirmer-b@example.com');
    const finalConfirmRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`);

    expect(finalConfirmRes.body.status).toBe('promoted');
  });
});
